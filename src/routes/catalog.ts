import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { calculateProductPrice, InvalidVariantSelectionError } from "../lib/catalog-pricing";

// ============================================================================
// src/routes/catalog.ts
// Route PUBLIK (tidak butuh login member ataupun x-admin-secret) — dipakai
// PWA buat nampilin katalog & hitung harga. Member login TETAP dipakai di sisi
// frontend untuk ambil data tier/ID saat generate pesan WhatsApp, tapi
// browsing katalog & cek harga sendiri nggak perlu login.
// ============================================================================
export default async function catalogRoutes(app: FastifyInstance) {
  // GET /api/catalog/products?category=HM_BOOKS_PRINTING
  app.get<{ Querystring: { category?: string } }>("/api/catalog/products", async (req, reply) => {
    const { category } = req.query;
    const products = await prisma.product.findMany({
      where: { active: true, ...(category ? { category: category as any } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return reply.send(products);
  });

  // GET /api/catalog/products/:slug
  app.get<{ Params: { slug: string } }>("/api/catalog/products/:slug", async (req, reply) => {
    const product = await prisma.product.findUnique({ where: { slug: req.params.slug } });
    if (!product || !product.active) return reply.code(404).send({ error: "Produk tidak ditemukan" });
    return reply.send(product);
  });

  // POST /api/catalog/products/:slug/price-check
  // Dipanggil frontend TEPAT SEBELUM generate link WhatsApp, buat verifikasi
  // ulang harga di server (jaga-jaga ada tamper di sisi client, atau harga
  // sempat diubah admin sesudah halaman kebuka). Kalkulasi live saat klik
  // chip di UI tetap dihitung instan di frontend (lihat calculateProductPriceJS
  // di index.html) — endpoint ini cuma jadi "penegasan akhir" sebelum order.
  app.post<{
    Params: { slug: string };
    Body: { selection: Record<string, string | string[]>; qty: number };
  }>("/api/catalog/products/:slug/price-check", async (req, reply) => {
    const product = await prisma.product.findUnique({ where: { slug: req.params.slug } });
    if (!product || !product.active) return reply.code(404).send({ error: "Produk tidak ditemukan" });

    const { selection, qty } = req.body;
    if (!selection || typeof qty !== "number") {
      return reply.code(400).send({ error: "selection dan qty wajib diisi" });
    }

    try {
      const result = calculateProductPrice(
        { variantGroups: product.variantGroups as any, priceConfig: product.priceConfig as any },
        selection,
        qty,
      );
      return reply.send(result);
    } catch (err: any) {
      if (err instanceof InvalidVariantSelectionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
