import { TxType, Tier, OrderFulfillmentStatus, OrderPaymentStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { calcTier, multiplierFor, tierRank, maxRedeemPercentFor, POINT_VALUE_RUPIAH } from "./tier";
import { generateRedeemCode } from "./codegen";

const MULTIPLIER_APPLIES_TO: TxType[] = ["EARN_MANUAL", "EARN_AUTO_KANBAN"];

// --- Konstanta cashout ---
export const CASHOUT_MIN_POINTS = 500;
export const CASHOUT_MIN_RUPIAH = CASHOUT_MIN_POINTS * POINT_VALUE_RUPIAH;

// ============================================================================
// SKEMA KOMISI REFERRAL — TIERING (menggantikan skema flat/bulk-threshold lama)
// Dihitung dari Badge Status REFERRER (Pengajak) pada SAAT teman yang diundang
// menyelesaikan transaksi pertamanya, BUKAN dari nilai transaksi teman itu
// sendiri (nilai transaksi cuma dipakai sebagai basis kalkulasi % untuk
// tier SILVER/GOLD/PLATINUM).
//
//   SOBAT     -> flat 100 poin (Rp 10.000), berapa pun nilai order teman
//   SILVER    -> 1%   dari total nilai transaksi pertama teman
//   GOLD      -> 1.5% dari total nilai transaksi pertama teman
//   PLATINUM  -> 2%   dari total nilai transaksi pertama teman
//
// Tier legacy (BRONZE_PAPER/SILVER_IVORY/GOLD_FOIL) di-mapping ke tier baru
// yang setara rangenya supaya member yang belum di-backfill tetap dapat
// komisi yang benar.
// ============================================================================
export const REFERRAL_FLAT_POINTS_SOBAT = 100; // Rp 10.000

const REFERRAL_COMMISSION_PERCENT: Record<string, number> = {
  SILVER: 0.01,
  GOLD: 0.015,
  PLATINUM: 0.02,
  // --- fallback tier legacy, disamakan dengan range yang setara ---
  SILVER_IVORY: 0.015, // setara GOLD baru
  GOLD_FOIL: 0.02, // setara PLATINUM baru
};

// Tier yang dapat FLAT (bukan persentase). SOBAT & legacy BRONZE_PAPER
// (range 0-4.999 lama) diperlakukan sama.
const FLAT_TIERS = new Set<string>(["SOBAT", "BRONZE_PAPER"]);

/**
 * Dilempar kalau tier referrer TIDAK DIKENALI sama sekali (bukan salah satu
 * dari SOBAT/SILVER/GOLD/PLATINUM atau tier legacy yang di-mapping). Dipakai
 * sebagai sinyal ke caller (addPoints) untuk fallback aman ke flat SOBAT
 * SUPAYA transaksi order utama teman TIDAK IKUT GAGAL/ROLLBACK gara-gara
 * data tier yang korup/di luar ekspektasi.
 */
export class UnknownReferrerTierError extends Error {}

export interface ReferralCommissionResult {
  points: number;
  percentApplied: number | null; // null = pakai flat (tier SOBAT)
}

export function calcReferralCommission(
  referrerTier: string,
  friendFirstOrderAmountRupiah: number,
): ReferralCommissionResult {
  if (FLAT_TIERS.has(referrerTier)) {
    return { points: REFERRAL_FLAT_POINTS_SOBAT, percentApplied: null };
  }

  const percent = REFERRAL_COMMISSION_PERCENT[referrerTier];
  if (percent === undefined) {
    throw new UnknownReferrerTierError(
      `Tier referrer tidak dikenali: "${referrerTier}". Tidak ada aturan komisi untuk tier ini.`,
    );
  }

  const points = Math.floor((friendFirstOrderAmountRupiah * percent) / POINT_VALUE_RUPIAH);
  return { points, percentApplied: percent };
}

/**
 * Nambah poin ke member. Multiplier tier otomatis diterapkan untuk poin
 * hasil transaksi (manual/auto), TAPI TIDAK untuk welcome bonus & transition
 * reward (itu jumlah flat yang sudah final, biar predictable).
 *
 * Kalau type === "EARN_AUTO_KANBAN" dan ini adalah TRANSAKSI PERTAMA member
 * ini, DAN member direferensikan oleh member lain (referredById terisi),
 * maka:
 *   1. Referrer otomatis dapat bonus poin sesuai TIER-nya saat ini (lihat
 *      calcReferralCommission) — dikreditkan LANGSUNG ke spendablePoints &
 *      referralPointsBalance supaya kelihatan di saldo & bisa dipakai untuk
 *      voucher/potong nota seperti biasa.
 *   2. TAPI poin itu juga langsung ditandai TERKUNCI (referralPointsLocked)
 *      dan dicatat sebagai 1 baris ReferralConversion berstatus
 *      PENDING/UNPAID. Poin ini BARU BOLEH diajukan Request Cashout setelah
 *      admin update status order teman jadi COMPLETED & PAID lewat
 *      updateReferralConversionStatus() di bawah.
 *
 * Wajib isi `orderAmountRupiah` untuk EARN_AUTO_KANBAN supaya bonus referral
 * & fitur potong nota bisa jalan.
 */
export async function addPoints(params: {
  memberId: string;
  basePoints: number;
  type: TxType;
  note?: string;
  refOrderId?: string;
  createdBy: string;
  orderAmountRupiah?: number;
}) {
  const { memberId, basePoints, type, note, refOrderId, createdBy, orderAmountRupiah } = params;

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId } });
    const applyMultiplier = MULTIPLIER_APPLIES_TO.includes(type);
    const multiplier = applyMultiplier ? multiplierFor(member.tier) : 1;
    const finalPoints = Math.round(basePoints * multiplier);
    const newLifetime = member.lifetimePoints + finalPoints;
    const newTier = calcTier(newLifetime);

    await tx.pointsTransaction.create({
      data: {
        memberId,
        type,
        spendableDelta: finalPoints,
        lifetimeDelta: finalPoints,
        note,
        refOrderId,
        createdBy,
      },
    });

    const updated = await tx.member.update({
      where: { id: memberId },
      data: {
        spendablePoints: { increment: finalPoints },
        lifetimePoints: newLifetime,
        tier: newTier,
      },
    });

    // --- Trigger bonus komisi referral ke REFERRER (order pertama via Kanban) ---
    let referralBonus: {
      referrerId: string;
      points: number;
      percentApplied: number | null;
      tierRecognized: boolean;
      conversionId: string;
    } | null = null;

    if (type === "EARN_AUTO_KANBAN" && member.referredById && orderAmountRupiah) {
      const priorKanbanCount = await tx.pointsTransaction.count({
        where: { memberId, type: "EARN_AUTO_KANBAN" },
      });
      // Transaksi yang barusan dibuat di atas sudah ikut ke-count, jadi
      // priorKanbanCount === 1 artinya ini order Kanban PERTAMA member ini.
      if (priorKanbanCount === 1) {
        // Cegah duplikasi kalau fungsi ini kepanggil dua kali untuk order yang
        // sama (mis. retry dari sistem Kanban) — 1 teman cuma boleh 1 conversion.
        const existingConversion = await tx.referralConversion.findUnique({
          where: { referredMemberId: memberId },
        });

        if (!existingConversion) {
          const referrer = await tx.member.findUnique({ where: { id: member.referredById } });

          if (referrer) {
            let bonusPoints: number;
            let percentApplied: number | null;
            let tierRecognized = true;

            try {
              const result = calcReferralCommission(referrer.tier, orderAmountRupiah);
              bonusPoints = result.points;
              percentApplied = result.percentApplied;
            } catch (err) {
              // Tier tidak dikenali -> JANGAN sampai transaksi order utama ikut
              // gagal/rollback. Fallback aman: flat SOBAT + tandai tierRecognized
              // = false supaya kelihatan jelas di audit trail & butuh dicek admin.
              tierRecognized = false;
              bonusPoints = REFERRAL_FLAT_POINTS_SOBAT;
              percentApplied = null;
            }

            await tx.pointsTransaction.create({
              data: {
                memberId: referrer.id,
                type: "EARN_REFERRAL",
                spendableDelta: bonusPoints,
                lifetimeDelta: 0, // poin referral TIDAK menaikkan tier referrer (murni dari transaksi cetak sendiri)
                note: tierRecognized
                  ? `Bonus referral order pertama ${member.name} (tier ${referrer.tier}${
                      percentApplied ? `, ${(percentApplied * 100).toFixed(1)}%` : ", flat"
                    }) — TERKUNCI sampai order COMPLETED & PAID`
                  : `[PERLU DICEK ADMIN] Tier "${referrer.tier}" tidak dikenali sistem komisi, fallback flat ${REFERRAL_FLAT_POINTS_SOBAT} poin — TERKUNCI sampai order COMPLETED & PAID`,
                refOrderId,
                createdBy: "system-referral",
              },
            });

            await tx.member.update({
              where: { id: referrer.id },
              data: {
                spendablePoints: { increment: bonusPoints },
                referralPointsBalance: { increment: bonusPoints },
                referralPointsLocked: { increment: bonusPoints },
              },
            });

            const conversion = await tx.referralConversion.create({
              data: {
                referrerId: referrer.id,
                referredMemberId: memberId,
                orderAmountRupiah,
                referrerTierAtEarn: referrer.tier,
                commissionPercent: percentApplied,
                pointsAwarded: bonusPoints,
                tierRecognized,
                refOrderId,
                orderFulfillmentStatus: "PENDING",
                orderPaymentStatus: "UNPAID",
              },
            });

            referralBonus = {
              referrerId: referrer.id,
              points: bonusPoints,
              percentApplied,
              tierRecognized,
              conversionId: conversion.id,
            };
          }
        }
      }
    }

    return { member: updated, pointsAwarded: finalPoints, tierChanged: newTier !== member.tier, referralBonus };
  });
}

export class ConversionNotFoundError extends Error {}

/**
 * Update status produksi/pembayaran order teman yang direferensikan.
 * Dipanggil admin lewat POST /api/admin/referral-conversions/:id/status
 * setiap kali status order berubah. Begitu KEDUA status jadi COMPLETED
 * (fulfillment) DAN PAID (payment) untuk PERTAMA KALINYA, gembok poin
 * referrer otomatis dibuka (referralPointsLocked dikurangi).
 *
 * Waterproof dua arah: kalau admin salah input & memundurkan status dari
 * yang sudah unlocked, poin dikunci lagi otomatis supaya tidak ada celah
 * cashout duluan lalu status order dibatalkan belakangan.
 */
export async function updateReferralConversionStatus(params: {
  conversionId: string;
  orderFulfillmentStatus?: OrderFulfillmentStatus;
  orderPaymentStatus?: OrderPaymentStatus;
  updatedBy: string;
}) {
  const { conversionId, orderFulfillmentStatus, orderPaymentStatus, updatedBy } = params;

  return prisma.$transaction(async (tx) => {
    const conversion = await tx.referralConversion.findUnique({ where: { id: conversionId } });
    if (!conversion) throw new ConversionNotFoundError("Referral conversion tidak ditemukan");

    const wasUnlocked =
      conversion.orderFulfillmentStatus === "COMPLETED" && conversion.orderPaymentStatus === "PAID";

    const updated = await tx.referralConversion.update({
      where: { id: conversionId },
      data: {
        orderFulfillmentStatus: orderFulfillmentStatus ?? conversion.orderFulfillmentStatus,
        orderPaymentStatus: orderPaymentStatus ?? conversion.orderPaymentStatus,
        pointsUnlockedAt:
          orderFulfillmentStatus === "COMPLETED" && orderPaymentStatus === "PAID" && !wasUnlocked
            ? new Date()
            : conversion.pointsUnlockedAt,
      },
    });

    const isNowUnlocked = updated.orderFulfillmentStatus === "COMPLETED" && updated.orderPaymentStatus === "PAID";

    if (!wasUnlocked && isNowUnlocked) {
      await tx.member.update({
        where: { id: conversion.referrerId },
        data: { referralPointsLocked: { decrement: conversion.pointsAwarded } },
      });
      await tx.pointsTransaction.create({
        data: {
          memberId: conversion.referrerId,
          type: "ADJUSTMENT",
          spendableDelta: 0,
          lifetimeDelta: 0,
          note: `Gembok dibuka: ${conversion.pointsAwarded} poin referral dari order teman siap dicairkan (order COMPLETED & PAID).`,
          createdBy: updatedBy,
        },
      });
    } else if (wasUnlocked && !isNowUnlocked) {
      // Status dimundurkan (mis. pembatalan/refund setelah sempat COMPLETED+PAID)
      await tx.member.update({
        where: { id: conversion.referrerId },
        data: { referralPointsLocked: { increment: conversion.pointsAwarded } },
      });
      await tx.pointsTransaction.create({
        data: {
          memberId: conversion.referrerId,
          type: "ADJUSTMENT",
          spendableDelta: 0,
          lifetimeDelta: 0,
          note: `Gembok dikunci ulang: status order teman dimundurkan, ${conversion.pointsAwarded} poin referral TIDAK bisa dicairkan sampai order COMPLETED & PAID lagi.`,
          createdBy: updatedBy,
        },
      });
    }

    return updated;
  });
}

export class RedeemError extends Error {}

export async function redeemVoucher(params: { memberId: string; voucherId: string }) {
  const { memberId, voucherId } = params;
  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId } });
    const voucher = await tx.voucher.findUniqueOrThrow({ where: { id: voucherId } });
    if (!voucher.active || voucher.stock <= 0) {
      throw new RedeemError("Voucher tidak tersedia / stok habis");
    }
    if (voucher.tierMin && tierRank(member.tier) < tierRank(voucher.tierMin)) {
      throw new RedeemError("Tier kamu belum memenuhi syarat voucher ini");
    }
    if (member.spendablePoints < voucher.costPoints) {
      throw new RedeemError("Poin tidak cukup");
    }
    const redeemCode = generateRedeemCode();
    await tx.pointsTransaction.create({
      data: {
        memberId,
        type: "REDEEM_VOUCHER",
        spendableDelta: -voucher.costPoints,
        lifetimeDelta: 0,
        note: `Redeem voucher: ${voucher.title}`,
        createdBy: "system",
      },
    });
    await tx.member.update({
      where: { id: memberId },
      data: { spendablePoints: { decrement: voucher.costPoints } },
    });
    await tx.voucher.update({
      where: { id: voucherId },
      data: { stock: { decrement: 1 } },
    });
    const redemption = await tx.redemption.create({
      data: {
        memberId,
        voucherId,
        pointsSpent: voucher.costPoints,
        redeemCode,
      },
    });
    return redemption;
  });
}

/**
 * Potong nota pakai poin saat checkout, dibatasi maksimal % dari total
 * tagihan sesuai tier member (Sobat 15% / Silver 25% / Gold 40% / Platinum 100%).
 * Dipanggil admin lewat POST /api/admin/points/redeem-nota saat order dikonfirmasi.
 */
export async function redeemForNota(params: {
  memberId: string;
  orderAmountRupiah: number;
  pointsRequested: number;
  refOrderId?: string;
  createdBy: string;
}) {
  const { memberId, orderAmountRupiah, pointsRequested, refOrderId, createdBy } = params;

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId } });
    const maxPercent = maxRedeemPercentFor(member.tier);
    const maxRupiah = Math.floor(orderAmountRupiah * maxPercent);
    const maxPoints = Math.floor(maxRupiah / POINT_VALUE_RUPIAH);
    const pointsToRedeem = Math.max(0, Math.min(pointsRequested, maxPoints, member.spendablePoints));

    if (pointsToRedeem <= 0) {
      throw new RedeemError(
        `Poin tidak bisa dipakai untuk nota ini (maks ${maxPoints} poin sesuai tier ${member.tier}, saldo member: ${member.spendablePoints} poin).`,
      );
    }

    const rupiahValue = pointsToRedeem * POINT_VALUE_RUPIAH;

    await tx.pointsTransaction.create({
      data: {
        memberId,
        type: "REDEEM_NOTA",
        spendableDelta: -pointsToRedeem,
        lifetimeDelta: 0,
        note: `Potong nota Rp${rupiahValue.toLocaleString("id-ID")}`,
        refOrderId,
        createdBy,
      },
    });

    const updated = await tx.member.update({
      where: { id: memberId },
      data: { spendablePoints: { decrement: pointsToRedeem } },
    });

    return {
      member: updated,
      pointsRedeemed: pointsToRedeem,
      rupiahValue,
      finalOrderTotal: orderAmountRupiah - rupiahValue,
    };
  });
}

/**
 * BARU — Strict Gembok Cashout Logic (waterproof).
 * Dipanggil dari POST /api/member/cashout. Melempar RedeemError kalau:
 *   - poin diminta < CASHOUT_MIN_POINTS (500 poin / Rp 50.000), atau
 *   - poin diminta > saldo referral yang SUDAH SIAP CAIR
 *     (referralPointsBalance - referralPointsLocked), yang berarti masih
 *     ada order teman yang belum berstatus COMPLETED & PAID.
 * Kalau lolos, poin langsung dipotong dari spendablePoints &
 * referralPointsBalance dan sebuah CashoutRequest berstatus "pending" dibuat
 * untuk diproses manual oleh admin (lihat routes/admin.ts).
 */
export async function requestCashout(params: {
  memberId: string;
  points: number;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  ewalletType?: string;
}) {
  const { memberId, points, bankName, accountNumber, accountName, ewalletType } = params;

  if (!points || points < CASHOUT_MIN_POINTS) {
    throw new RedeemError(
      `Minimal cashout ${CASHOUT_MIN_POINTS} poin (Rp${CASHOUT_MIN_RUPIAH.toLocaleString("id-ID")}).`,
    );
  }
  if (!ewalletType && !(bankName && accountNumber && accountName)) {
    throw new RedeemError("Isi salah satu: detail bank lengkap, atau tipe e-wallet.");
  }

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId } });

    const cashoutEligiblePoints = member.referralPointsBalance - member.referralPointsLocked;

    if (points > member.referralPointsBalance) {
      throw new RedeemError(`Saldo poin referral tidak cukup. Saldo kamu: ${member.referralPointsBalance} poin.`);
    }
    if (points > cashoutEligiblePoints) {
      throw new RedeemError(
        `Poin belum bisa dicairkan sepenuhnya. ${member.referralPointsLocked} poin masih terkunci ` +
          `karena order teman terkait belum berstatus COMPLETED & PAID. Poin siap cair saat ini: ${cashoutEligiblePoints}.`,
      );
    }
    if (points > member.spendablePoints) {
      throw new RedeemError(
        "Saldo poin aktif tidak cukup (mungkin sebagian sudah terpakai untuk potong nota/voucher).",
      );
    }

    const amountRupiah = points * POINT_VALUE_RUPIAH;

    const request = await tx.cashoutRequest.create({
      data: {
        memberId,
        pointsRequested: points,
        amountRupiah,
        bankName,
        accountNumber,
        accountName,
        ewalletType,
        status: "pending",
      },
    });

    // Poin langsung dikunci dari kedua saldo begitu request dibuat, supaya
    // tidak bisa dipakai dobel (potong nota) sambil nunggu approval admin.
    await tx.member.update({
      where: { id: memberId },
      data: {
        spendablePoints: { decrement: points },
        referralPointsBalance: { decrement: points },
      },
    });

    await tx.pointsTransaction.create({
      data: {
        memberId,
        type: "REDEEM_CASHOUT",
        spendableDelta: -points,
        lifetimeDelta: 0,
        note: `Request cashout Rp${amountRupiah.toLocaleString("id-ID")} (menunggu approval admin)`,
        createdBy: "system",
      },
    });

    return request;
  });
}
