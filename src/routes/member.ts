import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { serializeMember } from "./auth";

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
}
