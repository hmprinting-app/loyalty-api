import { TxType } from "@prisma/client";
import { prisma } from "./prisma";
import { calcTier, multiplierFor, tierRank } from "./tier";
import { generateRedeemCode } from "./codegen";

const MULTIPLIER_APPLIES_TO: TxType[] = ["EARN_MANUAL", "EARN_AUTO_KANBAN"];

/**
 * Nambah poin ke member. Multiplier tier otomatis diterapkan untuk poin
 * hasil transaksi (manual/auto), TAPI TIDAK untuk welcome bonus & transition
 * reward (itu jumlah flat yang sudah final, biar predictable).
 */
export async function addPoints(params: {
  memberId: string;
  basePoints: number;
  type: TxType;
  note?: string;
  refOrderId?: string;
  createdBy: string;
}) {
  const { memberId, basePoints, type, note, refOrderId, createdBy } = params;

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

    return { member: updated, pointsAwarded: finalPoints, tierChanged: newTier !== member.tier };
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
