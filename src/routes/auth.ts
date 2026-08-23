import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { addPoints, CASHOUT_MIN_POINTS, CASHOUT_MIN_RUPIAH } from "../lib/points";
import { tierLabel, tierProgress, POINT_VALUE_RUPIAH } from "../lib/tier";

const WELCOME_BONUS_POINTS = Number(process.env.WELCOME_BONUS_POINTS ?? 500);

export default async function authRoutes(app: FastifyInstance) {
  // Login pakai magic token dari link personal (vip.hmprinting.id/index.html?t=TOKEN)
  // Dipanggil sekali dari frontend saat token kebaca dari URL, hasilnya (jwt)
  // disimpan di localStorage biar login tetap nempel walau link aslinya udah nggak dipegang.
  app.post<{ Body: { token: string } }>("/api/auth/login", async (req, reply) => {
    const { token } = req.body;
    if (!token) return reply.code(400).send({ error: "Token wajib diisi" });
    const member = await prisma.member.findUnique({ where: { magicToken: token } });
    if (!member) return reply.code(404).send({ error: "Link tidak valid" });
    let currentMember = member;
    if (!member.welcomeBonusClaimed && WELCOME_BONUS_POINTS > 0) {
      const result = await addPoints({
        memberId: member.id,
        basePoints: WELCOME_BONUS_POINTS,
        type: "EARN_WELCOME",
        note: "Welcome bonus - member lama HM Printing",
        createdBy: "system",
      });
      currentMember = result.member;
    }
    currentMember = await prisma.member.update({
      where: { id: member.id },
      data: { lastLoginAt: new Date(), welcomeBonusClaimed: true },
    });
    const jwt = app.jwt.sign({ memberId: currentMember.id }, { expiresIn: "180d" });
    return reply.send({
      jwt,
      member: serializeMember(currentMember),
    });
  });
}

export function serializeMember(member: {
  id: string;
  name: string;
  phone: string;
  tier: string;
  spendablePoints: number;
  lifetimePoints: number;
  referralCode?: string | null;
  referralPointsBalance?: number;
  referralPointsLocked?: number;
}) {
  const progress = tierProgress(member.lifetimePoints);
  const referralPointsBalance = member.referralPointsBalance ?? 0;
  const referralPointsLocked = member.referralPointsLocked ?? 0;
  const cashoutEligiblePoints = Math.max(0, referralPointsBalance - referralPointsLocked);

  return {
    id: member.id,
    name: member.name,
    phone: member.phone,
    tier: member.tier,
    tierLabel: tierLabel(member.tier as any),
    spendablePoints: member.spendablePoints,
    lifetimePoints: member.lifetimePoints,
    spendablePointsRupiah: member.spendablePoints * POINT_VALUE_RUPIAH,
    nextTier: progress.nextTier,
    pointsToNextTier: progress.pointsToNext,
    referralCode: member.referralCode ?? null,
    referralPointsBalance,
    referralPointsLocked,
    cashout: {
      minPoints: CASHOUT_MIN_POINTS,
      minRupiah: CASHOUT_MIN_RUPIAH,
      cashoutEligiblePoints,
      eligible: cashoutEligiblePoints >= CASHOUT_MIN_POINTS,
    },
  };
}
