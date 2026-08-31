import { notifyAdminWA } from "./notify"; // <-- tambahin import ini di paling atas file

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

    // Return juga member & voucher biar bisa dipakai buat notif WA di luar transaction
    return { redemption, member, voucher };
  });

  // --- Notif WA ke admin, DI LUAR transaction, non-blocking ---
  // Sengaja tidak di-await sepenuhnya di sini pun tidak masalah (notifyAdminWA
  // sudah fire-and-forget di dalamnya), tapi tetap di luar $transaction supaya
  // request ke Fonnte tidak pernah menahan koneksi database.
  notifyAdminWA(
    `🔔 Redemption Baru!\n` +
    `Customer: ${result.member.name} (${result.member.phone})\n` +
    `Voucher: ${result.voucher.title}\n` +
    `Kode: ${result.redemption.redeemCode}\n` +
    `Poin terpakai: ${result.voucher.costPoints}`
  );

  return result.redemption;
}
