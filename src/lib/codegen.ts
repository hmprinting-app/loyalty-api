import { customAlphabet } from "nanoid";

// Tanpa karakter ambigu (0/O, 1/I) biar gampang dibacain admin/kasir
const nanoidCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

export function generateRedeemCode(): string {
  return `HMVIP-${nanoidCode()}`;
}
