import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { calcTier } from "../lib/tier";

// Sama persis dengan konstanta yang dipakai di index.html (calculateProductPriceJS
// & checkout) — HARUS SAMA biar validasi server gak beda sama tampilan customer.
const POINT_VALUE_RUPIAH = 100;
const TIER_MAX_REDEEM_PERCENT: Record<string, number> = {
  BRONZE_PAPER: 0.15,
  SILVER_IVORY: 0.25,
  GOLD_FOIL: 1.0,
  SOBAT: 0.15,
  SILVER: 0.25,
  GOLD: 0.4,
  PLATINUM: 1.0,
};

// ============================================================================
// BARU — Endpoint PUBLIK (bukan admin) buat NYATET permintaan potong poin
// customer saat klik "Pesan via WhatsApp" dengan checkbox "Potong pakai poin
// saya" dicentang. TIDAK ada poin yang beneran kepotong di sini — cuma
// dicatat sebagai status "pending" biar Bos CH bisa lihat daftarnya dan
// proses (potong beneran) 1 klik lewat Mode Admin, begitu order-nya fix.
//
// Kenapa publik (bukan di admin.ts yang wajib x-admin-secret)? Karena yang
// manggil ini adalah PWA di browser customer sendiri, bukan Bos CH — kalau
// dikunci x-admin-secret, customer gak akan pernah bisa manggilnya.
// ============================================================================
export default async function notaRedeemRequestRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      phone: string;
      productSlug?: string;
      productName: string;
      orderSummary: string;
      orderAmountRupiah: number;
      pointsRequested: number;
    };
  }>("/api/nota-redeem-requests", async (req, reply) => {
    const { phone, productSlug, productName, orderSummary, orderAmountRupiah, pointsRequested } = req.body;

    if (!phone || !productName || !orderSummary || !orderAmountRupiah || !pointsRequested) {
      return reply.code(400).send({
        error: "phone, productName, orderSummary, orderAmountRupiah, pointsRequested wajib diisi",
      });
    }
    if (orderAmountRupiah <= 0 || pointsRequested <= 0) {
      return reply.code(400).send({ error: "orderAmountRupiah & pointsRequested harus lebih dari 0" });
    }

    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) {
      return reply.code(404).send({ error: "Member dengan nomor ini belum terdaftar" });
    }

    // Validasi ulang di server (JANGAN percaya angka dari client mentah-mentah)
    // — cek poin cukup DAN gak ngelewatin batas maksimal tier member ini.
    if (pointsRequested > member.spendablePoints) {
      return reply.code(400).send({
        error: `Poin yang diminta (${pointsRequested}) melebihi saldo member (${member.spendablePoints}).`,
      });
    }
    const tier = calcTier(member.lifetimePoints);
    const maxPct = TIER_MAX_REDEEM_PERCENT[tier] ?? 0;
    const maxRupiahByTier = Math.floor(orderAmountRupiah * maxPct);
    const maxPointsByTier = Math.floor(maxRupiahByTier / POINT_VALUE_RUPIAH);
    if (pointsRequested > maxPointsByTier) {
      return reply.code(400).send({
        error: `Tier ${tier} cuma boleh potong nota maks ${Math.round(maxPct * 100)}% (${maxPointsByTier} poin untuk order ini).`,
      });
    }

    const discountRupiah = pointsRequested * POINT_VALUE_RUPIAH;
    const finalTotalRupiah = orderAmountRupiah - discountRupiah;

    const request = await prisma.notaRedeemRequest.create({
      data: {
        memberId: member.id,
        productSlug,
        productName,
        orderSummary,
        orderAmountRupiah,
        pointsRequested,
        discountRupiah,
        finalTotalRupiah,
      },
    });

    return reply.send({ request, message: "Permintaan tercatat, menunggu diproses admin." });
  });
}
