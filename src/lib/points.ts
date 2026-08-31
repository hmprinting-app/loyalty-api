import { TxType, Tier, OrderFulfillmentStatus, OrderPaymentStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { calcTier, multiplierFor, tierRank, maxRedeemPercentFor, POINT_VALUE_RUPIAH } from "./tier";
import { generateRedeemCode } from "./codegen";
import { notifyAdminWA } from "./notify";

const MULTIPLIER_APPLIES_TO: TxType[] = ["EARN_MANUAL", "EARN_AUTO_KANBAN"];

// --- Konstanta cashout ---
export const CASHOUT_MIN_POINTS = 500;
export const CASHOUT_MIN_RUPIAH = CASHOUT_MIN_POINTS * POINT_VALUE_RUPIAH;

export const REFERRAL_FLAT_POINTS_SOBAT = 100;

const REFERRAL_COMMISSION_PERCENT: Record<string, number> = {
  SILVER: 0.01,
  GOLD: 0.015,
  PLATINUM: 0.02,
  SILVER_IVORY: 0.015,
  GOLD_FOIL: 0.02,
};

const FLAT_TIERS = new Set<string>(["SOBAT", "BRONZE_PAPER"]);

export class UnknownReferrerTierError extends Error {}

export interface ReferralCommissionResult {
  points: number;
  percentApplied: number | null;
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
      if (priorKanbanCount === 1) {
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
              tierRecognized = false;
              bonusPoints = REFERRAL_FLAT_POINTS_SOBAT;
              percentApplied = null;
            }

            await tx.pointsTransaction.create({
              data: {
                memberId: referrer.id,
                type: "EARN_REFERRAL",
                spendableDelta: bonusPoints,
                lifetimeDelta: 0,
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

  const result = await prisma.$transaction(async (tx) => {
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

    return { redemption, member, voucher };
  });

  notifyAdminWA(
    `🔔 Redemption Baru!\n` +
    `Customer: ${result.member.name} (${result.member.phone})\n` +
    `Voucher: ${result.voucher.title}\n` +
    `Kode: ${result.redemption.redeemCode}\n` +
    `Poin terpakai: ${result.voucher.costPoints}`
  );

  return result.redemption;
}

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
