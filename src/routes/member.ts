import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { serializeMember } from "./auth";
import { CASHOUT_MIN_POINTS, CASHOUT_MIN_RUPIAH, RedeemError, requestCashout } from "../lib/points";

export default async function memberRoutes(app: FastifyInstance) {
  // Semua route di sini butuh Bearer JWT (didapat dari /api/auth/login)
  app.addHook("preHandler", app.authenticate);

  app.get("/api/member/me", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) return reply.code(404).send({ error: "Member tidak ditemukan" });
    return reply.send(serializeMember(member));
  });

  app.get("/api/member/transactions", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };
    const transactions = await prisma.pointsTransaction.findMany({
      where: { memberId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return reply.send(transactions);
  });

  app.get("/api/member/redemptions", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };
    const redemptions = await prisma.redemption.findMany({
      where: { memberId },
      include: { voucher: true },
      orderBy: { redeemedAt: "desc" },
    });
    return reply.send(redemptions);
  });

  // ============================================================
  // Referral Dashboard — sekarang menampilkan status GEMBOK per teman:
  // apakah order pertamanya sudah COMPLETED & PAID (poin siap cair) atau
  // masih PENDING (poin sudah masuk saldo tapi belum bisa di-cashout).
  // ============================================================
  app.get("/api/member/referral", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };

    const member = await prisma.member.findUnique({
      where: { id: memberId },
      include: {
        referrals: {
          select: {
            id: true,
            name: true,
            createdAt: true,
            referralConversionAsReferred: {
              select: {
                pointsAwarded: true,
                commissionPercent: true,
                orderFulfillmentStatus: true,
                orderPaymentStatus: true,
                pointsUnlockedAt: true,
              },
            },
          },
        },
      },
    });
    if (!member) return reply.code(404).send({ error: "Member tidak ditemukan" });

    const totalReferralEarned = await prisma.pointsTransaction.aggregate({
      where: { memberId, type: "EARN_REFERRAL" },
      _sum: { spendableDelta: true },
    });

    const cashoutEligiblePoints = Math.max(0, member.referralPointsBalance - member.referralPointsLocked);

    return reply.send({
      referralCode: member.referralCode,
      referralLink: member.referralCode
        ? `https://vip.hmprinting.id/daftar?ref=${member.referralCode}`
        : null,
      referralPointsBalance: member.referralPointsBalance,
      referralPointsLocked: member.referralPointsLocked,
      cashoutEligiblePoints,
      totalReferralPointsEarned: totalReferralEarned._sum.spendableDelta ?? 0,
      totalFriendsInvited: member.referrals.length,
      friendsWhoOrdered: member.referrals.filter((r: any) => r.referralConversionAsReferred).length,
      friends: member.referrals.map((r: any) => {
        const conv = r.referralConversionAsReferred;
        const isUnlocked = conv && conv.orderFulfillmentStatus === "COMPLETED" && conv.orderPaymentStatus === "PAID";
        return {
          name: r.name,
          joinedAt: r.createdAt,
          hasOrdered: !!conv,
          pointsAwarded: conv?.pointsAwarded ?? 0,
          commissionPercent: conv?.commissionPercent ?? null,
          orderFulfillmentStatus: conv?.orderFulfillmentStatus ?? null,
          orderPaymentStatus: conv?.orderPaymentStatus ?? null,
          cashoutStatus: !conv ? "belum_order" : isUnlocked ? "siap_cair" : "terkunci",
        };
      }),
      cashout: {
        minPoints: CASHOUT_MIN_POINTS,
        minRupiah: CASHOUT_MIN_RUPIAH,
        eligible: cashoutEligiblePoints >= CASHOUT_MIN_POINTS,
      },
    });
  });

  // ============================================================
  // Request Cashout poin referral ke bank/e-wallet.
  // Validasi STRICT GEMBOK ada di requestCashout() (src/lib/points.ts):
  // hanya poin dari teman yang order-nya sudah COMPLETED & PAID yang boleh
  // dicairkan, minimal 500 poin. Status request selalu "pending" dulu —
  // admin approve manual lewat POST /api/admin/cashouts/:id/approve.
  // ============================================================
  app.post<{
    Body: {
      points: number;
      bankName?: string;
      accountNumber?: string;
      accountName?: string;
      ewalletType?: string;
    };
  }>("/api/member/cashout", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };
    const { points, bankName, accountNumber, accountName, ewalletType } = req.body;

    try {
      const cashout = await requestCashout({
        memberId,
        points,
        bankName,
        accountNumber,
        accountName,
        ewalletType,
      });

      return reply.send({
        cashoutId: cashout.id,
        pointsRequested: cashout.pointsRequested,
        amountRupiah: cashout.amountRupiah,
        status: cashout.status,
        message: "Request cashout berhasil dikirim, akan diproses admin 1-2 hari kerja.",
      });
    } catch (err: any) {
      if (err instanceof RedeemError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // ============================================================
  // Cloud Storage Preview — file master milik member
  // ============================================================
  app.get("/api/member/files", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };
    const files = await prisma.cloudFile.findMany({
      where: { memberId },
      orderBy: { createdAt: "desc" },
    });
    return reply.send(files);
  });
}
