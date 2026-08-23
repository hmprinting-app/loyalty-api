import { TxType, Tier } from "@prisma/client";
import { prisma } from "./prisma";
import { calcTier, multiplierFor, tierRank, maxRedeemPercentFor, POINT_VALUE_RUPIAH } from "./tier";
import { generateRedeemCode } from "./codegen";

const MULTIPLIER_APPLIES_TO: TxType[] = ["EARN_MANUAL", "EARN_AUTO_KANBAN"];

// --- Konstanta referral & cashout ---
export const BULK_ORDER_THRESHOLD_RUPIAH = 2_000_000;
export const REFERRAL_RETAIL_FLAT_POINTS = 100;
export const REFERRAL_BULK_PERCENT = 0.02;
export const CASHOUT_MIN_POINTS = 500;
export const CASHOUT_MIN_RUPIAH = CASHOUT_MIN_POINTS * POINT_VALUE_RUPIAH;

export function calcReferralReward(firstOrderAmountRupiah: number): { points: number; isBulk: boolean } {
  if (firstOrderAmountRupiah >= BULK_ORDER_THRESHOLD_RUPIAH) {
    const bonusRupiah = firstOrderAmountRupiah * REFERRAL_BULK_PERCENT;
    return { points: Math.floor(bonusRupiah / POINT_VALUE_RUPIAH), isBulk: true };
  }
  return { points: REFERRAL_RETAIL_FLAT_POINTS, isBulk: false };
}

/**
 * Nambah poin ke member. Multiplier tier otomatis diterapkan untuk poin
 * hasil transaksi (manual/auto), TAPI TIDAK untuk welcome bonus & transition
 * reward (itu jumlah flat yang sudah final, biar predictable).
 *
 * BARU: kalau type === "EARN_AUTO_KANBAN" dan ini adalah TRANSAKSI PERTAMA
 * member ini dari sistem produksi, DAN member direferensikan oleh member lain
 * (referredById terisi), maka referrer otomatis dapat bonus poin referral.
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

    // --- Trigger bonus referral ke REFERRER (order pertama via Kanban) ---
    let referralBonus: { referrerId: string; points: number; isBulk: boolean } | null = null;

    if (type === "EARN_AUTO_KANBAN" && member.referredById && orderAmountRupiah) {
      const priorKanbanCount = await tx.pointsTransaction.count({
        where: { memberId, type: "EARN_AUTO_KANBAN" },
      });
      // Transaksi yang barusan dibuat di atas sudah ikut ke-count, jadi
      // priorKanbanCount === 1 artinya ini order Kanban PERTAMA member ini.
      if (priorKanbanCount === 1) {
        const { points: bonusPoints, isBulk } = calcReferralReward(orderAmountRupiah);
        const referrer = await tx.member.findUnique({ where: { id: member.referredById } });

        if (referrer) {
          await tx.pointsTransaction.create({
            data: {
              memberId: referrer.id,
              type: "EARN_REFERRAL",
              spendableDelta: bonusPoints,
              lifetimeDelta: 0, // poin referral TIDAK menaikkan tier referrer (murni dari transaksi cetak sendiri)
              note: isBulk
                ? `Bonus referral 2% order grosir pertama ${member.name}`
                : `Bonus referral order pertama ${member.name}`,
              refOrderId,
              createdBy: "system-referral",
            },
          });

          await tx.member.update({
            where: { id: referrer.id },
            data: {
              spendablePoints: { increment: bonusPoints },
              referralPointsBalance: { increment: bonusPoints },
            },
          });

          referralBonus = { referrerId: referrer.id, points: bonusPoints, isBulk };
        }
      }
    }

    return { member: updated, pointsAwarded: finalPoints, tierChanged: newTier !== member.tier, referralBonus };
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
 * BARU: Potong nota pakai poin saat checkout, dibatasi maksimal % dari total
 * tagihan sesuai tier member (Sobat 15% / Silver 25% / Gold 40% / Platinum 100%).
 * Dipanggil admin lewat POST /api/admin/points/redeem-nota saat order dikonfirmasi.
 */
/**
 * BARU: Potong nota pakai poin saat checkout, dibatasi maksimal % dari total
 * tagihan sesuai tier member (Sobat 15% / Silver 25% / Gold 40% / Platinum 100%).
 * Dipanggil admin lewat POST /api/admin/points/redeem-nota saat order dikonfirmasi.
 *
 * STRICT LOCK (Poin 5): kalau pointsRequested melebihi batas tier ATAU saldo
 * member, fungsi ini MELEMPAR RedeemError — TIDAK diam-diam di-clamp ke nilai
 * maksimal. Ini sengaja, supaya arus kas HM Printing tidak tergerus oleh input
 * yang salah/nekat dari sisi caller (baik bug FE maupun kesalahan input admin).
 */
export async function redeemForNota(params: {
  memberId: string;
  orderAmountRupiah: number;
  pointsRequested: number;
  refOrderId?: string;
  createdBy: string;
}) {
  const { memberId, orderAmountRupiah, pointsRequested, refOrderId, createdBy } = params;

  if (!pointsRequested || pointsRequested <= 0) {
    throw new RedeemError("pointsRequested harus lebih dari 0");
  }

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId } });
    const maxPercent = maxRedeemPercentFor(member.tier);
    const maxRupiah = Math.floor(orderAmountRupiah * maxPercent);
    const maxPoints = Math.floor(maxRupiah / POINT_VALUE_RUPIAH);

    // STRICT LOCK: tolak keras kalau melebihi batas tier (bukan clamp diam-diam)
    if (pointsRequested > maxPoints) {
      throw new RedeemError(
        `Penukaran ditolak: ${pointsRequested} poin melebihi batas maksimal tier ${member.tier} ` +
          `(${Math.round(maxPercent * 100)}% dari nota = maks ${maxPoints} poin / Rp${maxRupiah.toLocaleString("id-ID")}).`,
      );
    }

    // STRICT LOCK: tolak keras kalau saldo poin member tidak cukup
    if (pointsRequested > member.spendablePoints) {
      throw new RedeemError(
        `Penukaran ditolak: saldo poin member (${member.spendablePoints}) tidak cukup untuk menukar ${pointsRequested} poin.`,
      );
    }

    const pointsToRedeem = pointsRequested;
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
