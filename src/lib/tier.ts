import { Tier } from "@prisma/client";

// Threshold berdasarkan lifetime points (poin history, tidak pernah berkurang)
export function calcTier(lifetimePoints: number): Tier {
  if (lifetimePoints >= 15000) return "GOLD_FOIL";
  if (lifetimePoints >= 5000) return "SILVER_IVORY";
  return "BRONZE_PAPER";
}

// Multiplier dipakai saat poin didapat dari transaksi (manual/auto),
// TIDAK dipakai untuk welcome bonus / transition reward (jumlah flat).
export function multiplierFor(tier: Tier): number {
  switch (tier) {
    case "GOLD_FOIL":
      return 1.5;
    case "SILVER_IVORY":
      return 1.2;
    default:
      return 1;
  }
}

const TIER_RANK: Record<Tier, number> = {
  BRONZE_PAPER: 0,
  SILVER_IVORY: 1,
  GOLD_FOIL: 2,
};

export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

export function tierLabel(tier: Tier): string {
  switch (tier) {
    case "GOLD_FOIL":
      return "Gold Foil";
    case "SILVER_IVORY":
      return "Silver Ivory";
    default:
      return "Bronze Paper";
  }
}

const TIER_THRESHOLDS = { BRONZE_PAPER: 0, SILVER_IVORY: 5000, GOLD_FOIL: 15000 };

// Info progres ke tier berikutnya, dipakai buat progress bar di UI
export function tierProgress(lifetimePoints: number) {
  const tier = calcTier(lifetimePoints);
  if (tier === "GOLD_FOIL") {
    return { nextTier: null, pointsToNext: 0, currentFloor: TIER_THRESHOLDS.GOLD_FOIL };
  }
  const nextTier: Tier = tier === "BRONZE_PAPER" ? "SILVER_IVORY" : "GOLD_FOIL";
  const nextThreshold = TIER_THRESHOLDS[nextTier];
  return {
    nextTier,
    pointsToNext: Math.max(nextThreshold - lifetimePoints, 0),
    currentFloor: TIER_THRESHOLDS[tier],
  };
}
