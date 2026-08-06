import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { redeemVoucher, RedeemError } from "../lib/points";
import { tierRank } from "../lib/tier";

export default async function voucherRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/api/vouchers", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };
    const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId } });

    const vouchers = await prisma.voucher.findMany({
      where: { active: true },
      orderBy: { costPoints: "asc" },
    });

    const result = vouchers.map((v) => ({
      ...v,
      tierEligible: !v.tierMin || tierRank(member.tier) >= tierRank(v.tierMin),
      canAfford: member.spendablePoints >= v.costPoints,
    }));

    return reply.send(result);
  });

  app.post<{ Params: { id: string } }>("/api/vouchers/:id/redeem", async (req, reply) => {
    const { memberId } = req.user as { memberId: string };
    const { id } = req.params;

    try {
      const redemption = await redeemVoucher({ memberId, voucherId: id });
      return reply.send(redemption);
    } catch (err) {
      if (err instanceof RedeemError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
