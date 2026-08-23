import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { serializeMember } from "./auth";
import { CASHOUT_MIN_POINTS, CASHOUT_MIN_RUPIAH } from "../lib/points";
import { POINT_VALUE_RUPIAH } from "../lib/tier";

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
  // BARU: Referral Dashboard
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
            transactions: { where: { type: "EARN_AUTO_KANBAN" }, select: { id: true }, take: 1 },
          },
        },
      },
    });
    if (!member) return reply.code(404).send({ error: "Member tidak ditemukan" });

    const totalReferralEarned = await prisma.pointsTransaction.aggregate({
      where: { memberId, type: "EARN_REFERRAL" },
      _sum: { spendableDelta: true },
    });

    return reply.send({
      referralCode: member.referralCode,
      referralLink: member.referralCode
        ? `https://vip.hmprinting.id/daftar?ref=${member.referralCode}`
        : null,
      referralPointsBalance: member.referralPointsBalance,
      totalReferralPointsEarned: totalReferralEarned._sum.spendableDelta ?? 0,
      totalFriendsInvited: member.referrals.length,
      friendsWhoOrdered: member.referrals.filter((r) => r.transactions.length > 0).length,
      friends: member.referrals.map((r) => ({
        name: r.name,
        joinedAt: r.createdAt,
        hasOrdered: r.transactions.length > 0,
      })),
      cashout: {
        minPoints: CASHOUT_MIN_POINTS,
        minRupiah: CASHOUT_MIN_RUPIAH,
        eligible: member.referralPointsBalance >= CASHOUT_MIN_POINTS,
      },
    });
  });

  // ============================================================
  // BARU: Request Cashout poin referral ke bank/e-wallet
  // Status selalu "pending" dulu — admin approve manual lewat
  // POST /api/admin/cashouts/:id/approve (lihat routes/admin.ts)
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

    if (!points || points < CASHOUT_MIN_POINTS) {
      return reply.code(400).send({
        error: `Minimal cashout ${CASHOUT_MIN_POINTS} poin (Rp${CASHOUT_MIN_RUPIAH.toLocaleString("id-ID")}).`,
      });
    }
    if (!ewalletType && !(bankName && accountNumber && accountName)) {
      return reply.code(400).send({
        error: "Isi salah satu: detail bank lengkap, atau tipe e-wallet.",
      });
    }

    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) return reply.code(404).send({ error: "Member tidak ditemukan" });

    if (points > member.referralPointsBalance) {
      return reply.code(400).send({
        error: `Saldo poin referral tidak cukup. Saldo kamu: ${member.referralPointsBalance} poin.`,
      });
    }
    if (points > member.spendablePoints) {
      return reply.code(400).send({
        error: "Saldo poin aktif tidak cukup (mungkin sebagian sudah terpakai untuk potong nota/voucher).",
      });
    }

    const amountRupiah = points * POINT_VALUE_RUPIAH;

    const cashout = await prisma.$transaction(async (tx) => {
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

    return reply.send({
      cashoutId: cashout.id,
      pointsRequested: cashout.pointsRequested,
      amountRupiah: cashout.amountRupiah,
      status: cashout.status,
      message: "Request cashout berhasil dikirim, akan diproses admin 1-2 hari kerja.",
    });
  });

  // ============================================================
  // BARU: Cloud Storage Preview — file master milik member
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
