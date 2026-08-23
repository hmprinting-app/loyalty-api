import { prisma } from "./prisma";

function baseCodeFromName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return (cleaned || "HMV").slice(0, 3).padEnd(3, "X");
}

function randomDigits(length = 3): string {
  return Math.floor(Math.random() * 10 ** length)
    .toString()
    .padStart(length, "0");
}

/**
 * Generate kode referral unik untuk member baru, format: CEP123.
 * Retry maksimal 10x kalau collision (sangat jarang berkat kombinasi
 * prefix nama + random digit).
 */
export async function generateUniqueReferralCode(name: string): Promise<string> {
  const prefix = baseCodeFromName(name);

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `${prefix}${randomDigits(3)}`;
    const existing = await prisma.member.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }

  return `${prefix}${Date.now().toString().slice(-5)}`;
}
