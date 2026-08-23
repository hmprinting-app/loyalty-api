import { Tier } from "@prisma/client";

// ============================================================================
// src/lib/tier.ts
// 4 Level tier aktif: SOBAT, SILVER, GOLD, PLATINUM (dihitung dari lifetimePoints).
// Value enum lama (BRONZE_PAPER, SILVER_IVORY, GOLD_FOIL) dipertahankan di
// Prisma schema untuk histori, dan tetap didukung fallback di semua fungsi di
// bawah biar tidak ada member yang "nyangkut" kalau backfill belum jalan.
// ============================================================================

// Urutan dari terendah ke tertinggi
const TIER_ORDER: Tier[] = ["SOBAT", "SILVER", "GOLD", "PLATINUM"];

export function calcTier(lifetimePoints: number): Tier {
  if (lifetimePoints >= 15000) return "PLATINUM";
  if (lifetimePoints >= 5000) return "GOLD";
  if (lifetimePoints >= 1000) return "SILVER";
  return "SOBAT";
}

const LABELS: Record<string, string> = {
  SOBAT: "Sobat (Craft Paper)",
  SILVER: "Silver (Silver Ivory)",
  GOLD: "Gold (Gold Foil)",
  PLATINUM: "Platinum (Platinum Emboss)",
  // fallback untuk member yang belum ke-backfill
  BRONZE_PAPER: "Sobat (Craft Paper)",
  SILVER_IVORY: "Gold (Gold Foil)",
  GOLD_FOIL: "Platinum (Platinum Emboss)",
};

export function tierLabel(tier: Tier): string {
  return LABELS[tier] ?? tier;
}

// Multiplier earn poin per tier — disamakan dengan klaim benefit yang
// ditampilkan di modal "Lihat Benefit" pada PWA (Poin 2 enhancement).
const MULTIPLIERS: Record<string, number> = {
  SOBAT: 1.0,
  SILVER: 1.25,
  GOLD: 1.5,
  PLATINUM: 2.0,
  // fallback untuk member yang belum ke-backfill (value lama, sebelum sistem 4-tier)
  BRONZE_PAPER: 1.0,
  SILVER_IVORY: 1.5,
  GOLD_FOIL: 2.0,
};

export function multiplierFor(tier: Tier): number {
  return MULTIPLIERS[tier] ?? 1.0;
}

// Batas maksimal potong nota (% dari total tagihan) per tier
const MAX_REDEEM_PERCENT: Record<string, number> = {
  SOBAT: 0.15,
  SILVER: 0.25,
  GOLD: 0.4,
  PLATINUM: 1.0,
  BRONZE_PAPER: 0.15,
  SILVER_IVORY: 0.4,
  GOLD_FOIL: 1.0,
};

export function maxRedeemPercentFor(tier: Tier): number {
  return MAX_REDEEM_PERCENT[tier] ?? 0.15;
}

// Rank untuk perbandingan (dipakai voucher.tierMin gating). Value lama & baru
// disamakan rank-nya sesuai range yang setara.
const RANK: Record<string, number> = {
  BRONZE_PAPER: 0,
  SOBAT: 0,
  SILVER: 1,
  SILVER_IVORY: 2,
  GOLD: 2,
  GOLD_FOIL: 3,
  PLATINUM: 3,
};

export function tierRank(tier: Tier): number {
  return RANK[tier] ?? 0;
}

export interface TierProgressResult {
  nextTier: Tier | null;
  pointsToNext: number | null;
}

// Progress dihitung selalu berdasarkan tier BARU (SOBAT/SILVER/GOLD/PLATINUM),
// supaya UI konsisten walau member.tier di DB masih value lama (sebelum backfill).
export function tierProgress(lifetimePoints: number): TierProgressResult {
  const current = calcTier(lifetimePoints);
  const idx = TIER_ORDER.indexOf(current);

  if (idx === TIER_ORDER.length - 1) {
    return { nextTier: null, pointsToNext: null };
  }

  const nextTier = TIER_ORDER[idx + 1];
  const nextFloor = FLOORS[nextTier];
  return { nextTier, pointsToNext: Math.max(0, nextFloor - lifetimePoints) };
}

const FLOORS: Record<Tier, number> = {
  SOBAT: 0,
  SILVER: 1000,
  GOLD: 5000,
  PLATINUM: 15000,
  BRONZE_PAPER: 0,
  SILVER_IVORY: 5000,
  GOLD_FOIL: 15000,
};

export const POINT_VALUE_RUPIAH = 100; // 1 poin = Rp 100

export function pointsToRupiah(points: number): number {
  return points * POINT_VALUE_RUPIAH;
}

export function rupiahToPoints(rupiah: number): number {
  return Math.floor(rupiah / POINT_VALUE_RUPIAH);
}
