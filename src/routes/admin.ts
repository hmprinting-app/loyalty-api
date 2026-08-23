import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import {
  addPoints,
  redeemForNota,
  updateReferralConversionStatus,
  ConversionNotFoundError,
  RedeemError,
} from "../lib/points";
import { TxType, OrderFulfillmentStatus, OrderPaymentStatus } from "@prisma/client";
import { generateUniqueReferralCode } from "../lib/referral-code";
import { calcTier } from "../lib/tier";

const ADMIN_TYPES: TxType[] = ["EARN_MANUAL", "EARN_TRANSITION", "ADJUSTMENT"];
const VALID_FULFILLMENT: OrderFulfillmentStatus[] = ["PENDING", "IN_PRODUCTION", "COMPLETED", "CANCELLED"];
const VALID_PAYMENT: OrderPaymentStatus[] = ["UNPAID", "PARTIAL", "PAID", "REFUNDED"];

export default async function adminRoutes(app: FastifyInstance) {
  // Proteksi simpel pakai shared secret di header, BUKAN sistem login admin penuh.
  // Cukup buat dipakai internal tim HM Printing lewat script/Postman/admin page nanti.
  app.addHook("preHandler", async (req, reply) => {
    const secret = req.headers["x-admin-secret"];
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Tambah poin manual - dipakai buat transition reward & kasus manual lainnya
  app.post<{
    Body: { phone: string; points: number; type?: TxType; note?: string; createdBy?: string };
  }>("/api/admin/points/add", async (req, reply) => {
    const { phone, points, type = "EARN_MANUAL", note, createdBy = "admin" } = req.body;
    if (!ADMIN_TYPES.includes(type)) {
      return reply.code(400).send({ error: `Type harus salah satu dari: ${ADMIN_TYPES.join(", ")}` });
    }
    if (!points || points <= 0) {
      return reply.code(400).send({ error: "Points harus lebih dari 0" });
    }
    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) return reply.code(404).send({ error: "Member dengan nomor ini belum terdaftar" });
    const result = await addPoints({
      memberId: member.id,
      basePoints: points,
      type,
      note,
      createdBy,
    });
    return reply.send(result);
  });

  // Potong nota pakai poin (dipanggil admin saat konfirmasi order, baik
  // manual maupun nanti otomatis dari sistem Kanban)
  app.post<{
    Body: { phone: string; orderAmountRupiah: number; pointsRequested: number; refOrderId?: string };
  }>("/api/admin/points/redeem-nota", async (req, reply) => {
    const { phone, orderAmountRupiah, pointsRequested, refOrderId } = req.body;
    if (!orderAmountRupiah || orderAmountRupiah <= 0) {
      return reply.code(400).send({ error: "orderAmountRupiah wajib diisi & > 0" });
    }
    if (!pointsRequested || pointsRequested <= 0) {
      return reply.code(400).send({ error: "pointsRequested wajib diisi & > 0" });
    }
    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) return reply.code(404).send({ error: "Member dengan nomor ini belum terdaftar" });

    try {
      const result = await redeemForNota({
        memberId: member.id,
        orderAmountRupiah,
        pointsRequested,
        refOrderId,
        createdBy: "admin",
      });
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message ?? "Gagal potong nota" });
    }
  });

  // Buat 1 member baru + magic link-nya (dipakai juga oleh script bulk-import)
  // Dukung referredByCode -> kalau valid, member baru dapat 50 poin welcome
  // bonus referral (terpisah dari welcome bonus login 500 poin member lama).
  app.post<{ Body: { phone: string; name: string; referredByCode?: string } }>(
    "/api/admin/members",
    async (req, reply) => {
      const { phone, name, referredByCode } = req.body;
      if (!phone || !name) return reply.code(400).send({ error: "phone & name wajib diisi" });

      const existing = await prisma.member.findUnique({ where: { phone } });
      if (existing) return reply.code(409).send({ error: "Member sudah terdaftar", member: existing });

      let referredById: string | undefined;
      let referrerName: string | null = null;
      if (referredByCode) {
        const referrer = await prisma.member.findUnique({ where: { referralCode: referredByCode } });
        if (referrer) {
          referredById = referrer.id;
          referrerName = referrer.name;
        }
        // Kalau kode tidak valid, tetap lanjut daftar biasa (tanpa bonus)
        // daripada bikin signup gagal gara-gara typo kode referral.
      }

      const referralCode = await generateUniqueReferralCode(name);

      const member = await prisma.member.create({
        data: {
          phone,
          name,
          referralCode,
          referredById,
          welcomeBonusClaimed: !!referredById,
        },
      });

      let welcomeBonusGranted = 0;
      if (referredById) {
        welcomeBonusGranted = 50;
        await addPoints({
          memberId: member.id,
          basePoints: welcomeBonusGranted,
          type: "EARN_MANUAL",
          note: `Welcome bonus daftar via referral ${referrerName ?? ""}`.trim(),
          createdBy: "system-referral",
        });
      }

      const updatedMember = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });

      return reply.send({
        member: updatedMember,
        welcomeBonusGranted,
        referredBy: referredById ?? null,
        personalLink: `${process.env.FRONTEND_URL ?? "https://vip.hmprinting.id"}/index.html?t=${updatedMember.magicToken}`,
      });
    },
  );

  app.get("/api/admin/members", async (req, reply) => {
    const members = await prisma.member.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return reply.send(members);
  });

  // ============================================================
  // BARU — Set/update foto profil member (Bos CH upload foto asli
  // customer ke Cloudflare Images / Google Drive / dsb, terus taruh link-nya
  // di sini). Kalau kosong, PWA otomatis fallback ke avatar inisial nama.
  // ============================================================
  app.post<{ Body: { phone: string; photoUrl: string | null } }>(
    "/api/admin/members/photo",
    async (req, reply) => {
      const { phone, photoUrl } = req.body;
      if (!phone) return reply.code(400).send({ error: "phone wajib diisi" });

      const member = await prisma.member.findUnique({ where: { phone } });
      if (!member) return reply.code(404).send({ error: "Member dengan nomor ini belum terdaftar" });

      const updated = await prisma.member.update({
        where: { phone },
        data: { photoUrl: photoUrl || null },
      });

      return reply.send({ phone: updated.phone, name: updated.name, photoUrl: updated.photoUrl });
    },
  );

  app.get<{ Params: { phone: string } }>("/api/admin/members/:phone", async (req, reply) => {
    const member = await prisma.member.findUnique({
      where: { phone: req.params.phone },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 20 } },
    });
    if (!member) return reply.code(404).send({ error: "Tidak ditemukan" });
    return reply.send(member);
  });

  // ============================================================
  // BARU — List & update ReferralConversion (kontrol GEMBOK cashout)
  // ============================================================

  // List conversion, default yang belum "siap cair" (masih ada kerjaan admin).
  // Query: ?status=pending (default) | unlocked | all
  app.get<{ Querystring: { status?: "pending" | "unlocked" | "all" } }>(
    "/api/admin/referral-conversions",
    async (req, reply) => {
      const status = req.query?.status ?? "pending";

      const where =
        status === "unlocked"
          ? { orderFulfillmentStatus: "COMPLETED" as const, orderPaymentStatus: "PAID" as const }
          : status === "all"
            ? {}
            : {
                NOT: { orderFulfillmentStatus: "COMPLETED" as const, orderPaymentStatus: "PAID" as const },
              };

      const conversions = await prisma.referralConversion.findMany({
        where,
        include: {
          referrer: { select: { name: true, phone: true, tier: true } },
          referredMember: { select: { name: true, phone: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return reply.send(conversions);
    },
  );

  // Update status fulfillment/payment 1 conversion. Begitu keduanya
  // COMPLETED + PAID, gembok poin referrer otomatis lepas (lihat
  // updateReferralConversionStatus di src/lib/points.ts).
  app.post<{
    Params: { id: string };
    Body: { orderFulfillmentStatus?: OrderFulfillmentStatus; orderPaymentStatus?: OrderPaymentStatus };
  }>("/api/admin/referral-conversions/:id/status", async (req, reply) => {
    const { orderFulfillmentStatus, orderPaymentStatus } = req.body;

    if (orderFulfillmentStatus && !VALID_FULFILLMENT.includes(orderFulfillmentStatus)) {
      return reply.code(400).send({ error: `orderFulfillmentStatus harus salah satu dari: ${VALID_FULFILLMENT.join(", ")}` });
    }
    if (orderPaymentStatus && !VALID_PAYMENT.includes(orderPaymentStatus)) {
      return reply.code(400).send({ error: `orderPaymentStatus harus salah satu dari: ${VALID_PAYMENT.join(", ")}` });
    }
    if (!orderFulfillmentStatus && !orderPaymentStatus) {
      return reply.code(400).send({ error: "Isi minimal salah satu: orderFulfillmentStatus atau orderPaymentStatus" });
    }

    try {
      const updated = await updateReferralConversionStatus({
        conversionId: req.params.id,
        orderFulfillmentStatus,
        orderPaymentStatus,
        updatedBy: "admin",
      });
      const unlocked = updated.orderFulfillmentStatus === "COMPLETED" && updated.orderPaymentStatus === "PAID";
      return reply.send({
        conversion: updated,
        message: unlocked
          ? "Order sudah COMPLETED & PAID — poin referral siap dicairkan."
          : "Status diperbarui. Poin masih terkunci sampai order COMPLETED & PAID.",
      });
    } catch (err: any) {
      if (err instanceof ConversionNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });

  // ============================================================
  // Approve / Reject Cashout Request
  // ============================================================
  app.post<{ Params: { id: string }; Body: { adminNote?: string } }>(
    "/api/admin/cashouts/:id/approve",
    async (req, reply) => {
      const cashout = await prisma.cashoutRequest.update({
        where: { id: req.params.id },
        data: { status: "approved", processedAt: new Date(), adminNote: req.body?.adminNote },
      });
      return reply.send({ cashout, message: "Cashout disetujui. Lanjut transfer manual ke rekening/e-wallet member." });
    },
  );

  app.post<{ Params: { id: string }; Body: { adminNote?: string } }>(
    "/api/admin/cashouts/:id/reject",
    async (req, reply) => {
      const cashout = await prisma.cashoutRequest.findUnique({ where: { id: req.params.id } });
      if (!cashout) return reply.code(404).send({ error: "Cashout request tidak ditemukan" });
      if (cashout.status !== "pending") {
        return reply.code(400).send({ error: `Cashout ini sudah berstatus ${cashout.status}` });
      }

      const updated = await prisma.$transaction(async (tx: any) => {
        const rejected = await tx.cashoutRequest.update({
          where: { id: cashout.id },
          data: { status: "rejected", processedAt: new Date(), adminNote: req.body?.adminNote },
        });
        // Kembalikan poin yang sempat dikunci ke saldo member. Karena poin ini
        // sudah pernah verified (syarat requestCashout), kembalikan sebagai
        // saldo BEBAS (tidak perlu balikin ke referralPointsLocked lagi).
        await tx.member.update({
          where: { id: cashout.memberId },
          data: {
            spendablePoints: { increment: cashout.pointsRequested },
            referralPointsBalance: { increment: cashout.pointsRequested },
          },
        });
        await tx.pointsTransaction.create({
          data: {
            memberId: cashout.memberId,
            type: "ADJUSTMENT",
            spendableDelta: cashout.pointsRequested,
            lifetimeDelta: 0,
            note: `Cashout ditolak, poin dikembalikan${req.body?.adminNote ? ": " + req.body.adminNote : ""}`,
            createdBy: "admin",
          },
        });
        return rejected;
      });

      return reply.send({ cashout: updated, message: "Cashout ditolak, poin sudah dikembalikan ke member." });
    },
  );

  app.get("/api/admin/cashouts", async (req, reply) => {
    const cashouts = await prisma.cashoutRequest.findMany({
      where: { status: "pending" },
      include: { member: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "asc" },
    });
    return reply.send(cashouts);
  });

  // ============================================================
  // Upload metadata file master (Cloud Storage Preview)
  // ============================================================
  app.post<{
    Body: { phone: string; fileName: string; fileUrl: string; category?: string; note?: string };
  }>("/api/admin/files", async (req, reply) => {
    const { phone, fileName, fileUrl, category, note } = req.body;
    if (!phone || !fileName || !fileUrl) {
      return reply.code(400).send({ error: "phone, fileName, dan fileUrl wajib diisi" });
    }
    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) return reply.code(404).send({ error: "Member dengan nomor ini belum terdaftar" });

    const file = await prisma.cloudFile.create({
      data: { memberId: member.id, fileName, fileUrl, category, note },
    });
    return reply.send(file);
  });

  // ============================================================
  // (pengganti script CLI) Backfill tier & referralCode
  // Aman dipanggil BERKALI-KALI (idempotent).
  // ============================================================
  app.post("/api/admin/maintenance/backfill-tier-referral", async (req, reply) => {
    const membersToFix = await prisma.member.findMany({
      where: {
        OR: [{ tier: { in: ["BRONZE_PAPER", "SILVER_IVORY", "GOLD_FOIL"] } }, { referralCode: null }],
      },
    });

    let tierUpdated = 0;
    let codeGenerated = 0;

    for (const member of membersToFix) {
      const data: { tier?: any; referralCode?: string } = {};

      const newTier = calcTier(member.lifetimePoints);
      if (newTier !== member.tier) {
        data.tier = newTier;
        tierUpdated++;
      }

      if (!member.referralCode) {
        data.referralCode = await generateUniqueReferralCode(member.name);
        codeGenerated++;
      }

      if (Object.keys(data).length > 0) {
        await prisma.member.update({ where: { id: member.id }, data });
      }
    }

    const voucherTierMap: Record<string, "SOBAT" | "GOLD" | "PLATINUM"> = {
      BRONZE_PAPER: "SOBAT",
      SILVER_IVORY: "GOLD",
      GOLD_FOIL: "PLATINUM",
    };
    let vouchersUpdated = 0;
    for (const [oldTier, newTier] of Object.entries(voucherTierMap)) {
      const result = await prisma.voucher.updateMany({
        where: { tierMin: oldTier as any },
        data: { tierMin: newTier },
      });
      vouchersUpdated += result.count;
    }

    return reply.send({
      totalMembersChecked: membersToFix.length,
      tierUpdated,
      referralCodeGenerated: codeGenerated,
      vouchersTierMinUpdated: vouchersUpdated,
      message: "Backfill selesai. Aman dipanggil ulang kapan saja kalau ada member baru yang perlu di-fix.",
    });
  });

  // ============================================================
  // (pengganti script CLI) Campaign "Jumat Berkah"
  // ============================================================
  app.post<{ Body: { bulkBuyerPhones?: string[]; dryRun?: boolean } }>(
    "/api/admin/campaigns/jumat-berkah",
    async (req, reply) => {
      const bulkBuyerPhones = new Set(req.body?.bulkBuyerPhones ?? []);
      const dryRun = req.body?.dryRun ?? false;

      const eligibleMembers = await prisma.member.findMany({
        where: { lifetimePoints: 0, spendablePoints: 0 },
      });

      const results: { name: string; phone: string; bonus: number; isBulkBuyer: boolean }[] = [];

      for (const member of eligibleMembers) {
        const isBulkBuyer = bulkBuyerPhones.has(member.phone);
        const bonus = isBulkBuyer ? 500 : 50;

        if (!dryRun) {
          await addPoints({
            memberId: member.id,
            basePoints: bonus,
            type: "EARN_MANUAL",
            note: isBulkBuyer ? "Jumat Berkah - Bulk Buyer" : "Jumat Berkah - Welcome Bonus",
            createdBy: "system-jumat-berkah",
          });
        }

        results.push({ name: member.name, phone: member.phone, bonus, isBulkBuyer });
      }

      return reply.send({
        dryRun,
        totalEligible: eligibleMembers.length,
        normalBonusCount: results.filter((r) => !r.isBulkBuyer).length,
        bulkBuyerBonusCount: results.filter((r) => r.isBulkBuyer).length,
        details: results,
        message: dryRun
          ? "Ini DRY RUN — kirim ulang dengan dryRun:false untuk benar-benar kasih poin."
          : "Selesai! Poin sudah dibagikan ke semua member yang eligible.",
      });
    },
  );

  // ============================================================
  // BARU (pengganti seeder CLI) — Seed data demo skema komisi tiering.
  // Bikin 4 member dummy (satu per tier) + masing-masing 1 teman referral
  // dengan order pertama senilai Rp 1.000.000, supaya kamu bisa langsung
  // lihat & tes bedanya komisi flat vs persentase per tier di dashboard.
  // AMAN dipanggil di lingkungan testing/staging saja — jangan dipanggil di
  // database produksi yang sudah ada data asli (nomor HP dummy dipakai
  // supaya tidak bentrok, tapi tetap cek dulu sebelum jalanin di produksi).
  // ============================================================
  app.post<{ Body: { demoOrderAmountRupiah?: number } }>(
    "/api/admin/maintenance/seed-referral-tier-demo",
    async (req, reply) => {
      const orderAmount = req.body?.demoOrderAmountRupiah ?? 1_000_000;
      const tiers: { tier: "SOBAT" | "SILVER" | "GOLD" | "PLATINUM"; lifetimePoints: number }[] = [
        { tier: "SOBAT", lifetimePoints: 500 },
        { tier: "SILVER", lifetimePoints: 2000 },
        { tier: "GOLD", lifetimePoints: 8000 },
        { tier: "PLATINUM", lifetimePoints: 20000 },
      ];

      const created: any[] = [];

      for (const t of tiers) {
        const referrerPhone = `62800${t.tier.slice(0, 3)}0001`.slice(0, 15);
        const friendPhone = `62800${t.tier.slice(0, 3)}0002`.slice(0, 15);

        let referrer = await prisma.member.findUnique({ where: { phone: referrerPhone } });
        if (!referrer) {
          referrer = await prisma.member.create({
            data: {
              phone: referrerPhone,
              name: `Demo Referrer ${t.tier}`,
              tier: t.tier,
              lifetimePoints: t.lifetimePoints,
              spendablePoints: t.lifetimePoints,
              referralCode: await generateUniqueReferralCode(`Demo ${t.tier}`),
              welcomeBonusClaimed: true,
            },
          });
        }

        let friend = await prisma.member.findUnique({ where: { phone: friendPhone } });
        if (!friend) {
          friend = await prisma.member.create({
            data: {
              phone: friendPhone,
              name: `Demo Teman ${t.tier}`,
              referredById: referrer.id,
              welcomeBonusClaimed: true,
            },
          });
        }

        const alreadyHasConversion = await prisma.referralConversion.findUnique({
          where: { referredMemberId: friend.id },
        });

        let result = null;
        if (!alreadyHasConversion) {
          result = await addPoints({
            memberId: friend.id,
            basePoints: Math.floor(orderAmount / 10000), // simulasi 1 poin per Rp10rb dari order Kanban
            type: "EARN_AUTO_KANBAN",
            note: "Demo seed - order pertama",
            createdBy: "system-seed-demo",
            orderAmountRupiah: orderAmount,
          });
        }

        created.push({
          tier: t.tier,
          referrer: { phone: referrer.phone, name: referrer.name },
          friend: { phone: friend.phone, name: friend.name },
          referralBonus: result?.referralBonus ?? "sudah ada dari seed sebelumnya (idempotent)",
        });
      }

      return reply.send({
        orderAmountRupiah: orderAmount,
        message: "Demo data dibuat/diverifikasi untuk 4 tier. Cek GET /api/admin/referral-conversions untuk lihat hasil komisinya.",
        details: created,
      });
    },
  );

  // ============================================================
  // BARU — Pembersih data demo (lawan dari seed-referral-tier-demo).
  // Menghapus SEMUA member yang namanya diawali "Demo " beserta seluruh data
  // terkait (PointsTransaction, ReferralConversion, Redemption, CashoutRequest,
  // CloudFile). Aman dipanggil berkali-kali — kalau tidak ada data demo yang
  // ketemu, cuma balik "deleted: 0" tanpa efek apa-apa.
  // ============================================================
  app.post("/api/admin/maintenance/cleanup-referral-tier-demo", async (req, reply) => {
    const demoMembers = await prisma.member.findMany({
      where: { name: { startsWith: "Demo " } },
      select: { id: true, name: true, phone: true },
    });

    if (demoMembers.length === 0) {
      return reply.send({ deleted: 0, message: "Tidak ada data demo yang ditemukan — sudah bersih." });
    }

    const demoIds = demoMembers.map((m: { id: string }) => m.id);

    const result = await prisma.$transaction(async (tx: any) => {
      // Urutan hapus tidak krusial untuk relasi Member<->Member (referredById
      // pakai ON DELETE SET NULL), tapi tetap hapus child records dulu biar
      // aman kalau suatu saat constraint-nya diubah jadi RESTRICT.
      await tx.referralConversion.deleteMany({
        where: { OR: [{ referrerId: { in: demoIds } }, { referredMemberId: { in: demoIds } }] },
      });
      await tx.pointsTransaction.deleteMany({ where: { memberId: { in: demoIds } } });
      await tx.redemption.deleteMany({ where: { memberId: { in: demoIds } } });
      await tx.cashoutRequest.deleteMany({ where: { memberId: { in: demoIds } } });
      await tx.cloudFile.deleteMany({ where: { memberId: { in: demoIds } } });
      return tx.member.deleteMany({ where: { id: { in: demoIds } } });
    });

    return reply.send({
      deleted: result.count,
      deletedMembers: demoMembers.map((m: { name: string; phone: string }) => ({ name: m.name, phone: m.phone })),
      message: `${result.count} member demo & seluruh data terkait (transaksi, conversion, dll) berhasil dihapus.`,
    });
  });

  // ============================================================
  // BARU — Webhook untuk integrasi OTOMATIS dengan sistem Kanban produksi.
  //
  // Ini fondasi supaya update status TIDAK PERLU manual satu-satu lewat
  // dashboard admin. Alurnya nanti:
  //   1. Waktu order pertama customer referral tercatat (via addPoints
  //      type EARN_AUTO_KANBAN), Kanban WAJIB kirim `refOrderId` = ID order
  //      di sistem Kanban kamu sendiri (field ini sudah ada di schema).
  //   2. Begitu admin klik "Selesai Produksi" / "Lunas" di Kanban, sistem
  //      Kanban tinggal panggil endpoint INI dengan `refOrderId` yang sama
  //      — TIDAK perlu tahu ID internal ReferralConversion sama sekali.
  //   3. Gembok poin referrer otomatis kebuka begitu kedua status jadi
  //      COMPLETED & PAID — sama persis logic-nya dengan update manual.
  //
  // Kalau refOrderId yang dikirim TERNYATA bukan order dari customer
  // referral (mayoritas order memang bukan referral), endpoint ini TIDAK
  // error — cuma balas `skipped: true` karena memang tidak ada yang perlu
  // diupdate. Jadi Kanban bisa panggil endpoint ini untuk SEMUA order tanpa
  // perlu tahu duluan mana yang referral mana yang bukan.
  // ============================================================
  app.post<{
    Params: { refOrderId: string };
    Body: { orderFulfillmentStatus?: OrderFulfillmentStatus; orderPaymentStatus?: OrderPaymentStatus };
  }>("/api/admin/referral-conversions/by-order/:refOrderId/status", async (req, reply) => {
    const { orderFulfillmentStatus, orderPaymentStatus } = req.body;

    if (orderFulfillmentStatus && !VALID_FULFILLMENT.includes(orderFulfillmentStatus)) {
      return reply.code(400).send({ error: `orderFulfillmentStatus harus salah satu dari: ${VALID_FULFILLMENT.join(", ")}` });
    }
    if (orderPaymentStatus && !VALID_PAYMENT.includes(orderPaymentStatus)) {
      return reply.code(400).send({ error: `orderPaymentStatus harus salah satu dari: ${VALID_PAYMENT.join(", ")}` });
    }
    if (!orderFulfillmentStatus && !orderPaymentStatus) {
      return reply.code(400).send({ error: "Isi minimal salah satu: orderFulfillmentStatus atau orderPaymentStatus" });
    }

    const conversion = await prisma.referralConversion.findFirst({
      where: { refOrderId: req.params.refOrderId },
    });

    if (!conversion) {
      return reply.send({
        skipped: true,
        message: "Order ini tidak terkait referral manapun (customer non-referral) — tidak ada yang perlu diupdate.",
      });
    }

    try {
      const updated = await updateReferralConversionStatus({
        conversionId: conversion.id,
        orderFulfillmentStatus,
        orderPaymentStatus,
        updatedBy: "kanban-webhook",
      });
      const unlocked = updated.orderFulfillmentStatus === "COMPLETED" && updated.orderPaymentStatus === "PAID";
      return reply.send({
        skipped: false,
        conversion: updated,
        message: unlocked
          ? "Order sudah COMPLETED & PAID — poin referral siap dicairkan."
          : "Status diperbarui. Poin masih terkunci sampai order COMPLETED & PAID.",
      });
    } catch (err: any) {
      if (err instanceof ConversionNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });

  // ============================================================
  // BARU — CRUD Produk Katalog (Poin 1: Variant Selector Shopee-style)
  // ============================================================

  // Buat/replace 1 produk (upsert by slug) — dipakai buat nambah produk baru
  // ATAU update harga/varian produk yang sudah ada, cukup panggil ulang
  // dengan slug yang sama.
  app.post<{
    Body: {
      slug: string;
      name: string;
      category: "HM_BOOKS_PRINTING" | "PACKAGING" | "PROMOSI_LAINNYA";
      badge?: string;
      description?: string;
      image?: string;
      unit?: string;
      variantGroups: any;
      priceConfig: any;
      active?: boolean;
    };
  }>("/api/admin/products", async (req, reply) => {
    const { slug, name, category, badge, description, image, unit, variantGroups, priceConfig, active } = req.body;
    if (!slug || !name || !category || !variantGroups || !priceConfig) {
      return reply.code(400).send({ error: "slug, name, category, variantGroups, priceConfig wajib diisi" });
    }

    const product = await prisma.product.upsert({
      where: { slug },
      create: {
        slug,
        name,
        category,
        badge,
        description,
        image,
        unit: unit ?? "pcs",
        variantGroups,
        priceConfig,
        active: active ?? true,
      },
      update: {
        name,
        category,
        badge,
        description,
        image,
        unit: unit ?? "pcs",
        variantGroups,
        priceConfig,
        active: active ?? true,
      },
    });

    return reply.send(product);
  });

  app.get<{ Querystring: { category?: string } }>("/api/admin/products", async (req, reply) => {
    const products = await prisma.product.findMany({
      where: req.query.category ? { category: req.query.category as any } : {},
      orderBy: { createdAt: "asc" },
    });
    return reply.send(products);
  });

  app.delete<{ Params: { slug: string } }>("/api/admin/products/:slug", async (req, reply) => {
    const product = await prisma.product.findUnique({ where: { slug: req.params.slug } });
    if (!product) return reply.code(404).send({ error: "Produk tidak ditemukan" });
    await prisma.product.delete({ where: { slug: req.params.slug } });
    return reply.send({ deleted: true, slug: req.params.slug });
  });

  // Toggle aktif/nonaktif produk tanpa perlu kirim ulang semua field
  app.post<{ Params: { slug: string }; Body: { active: boolean } }>(
    "/api/admin/products/:slug/active",
    async (req, reply) => {
      const product = await prisma.product.update({
        where: { slug: req.params.slug },
        data: { active: req.body.active },
      });
      return reply.send(product);
    },
  );

  // ============================================================
  // BARU — Seeder 6 produk kategori "HM Books & Printing" dengan Variant
  // Selector Shopee-style. SEMUA ANGKA DI SINI ADALAH CONTOH/PLACEHOLDER
  // supaya sistemnya bisa langsung dites end-to-end — Bos CH WAJIB cek &
  // ganti ke harga riil lewat POST /api/admin/products (kirim ulang slug
  // yang sama dengan priceConfig baru).
  //
  // Perhatikan: Undangan & ID Card SENGAJA tidak dikasih dimensi "Halaman"
  // karena memang bukan produk berhalaman — sistemnya generik, jadi tiap
  // produk cuma pakai dimensi variant yang relevan buat produk itu.
  // ============================================================
  app.post("/api/admin/maintenance/seed-books-printing-catalog", async (req, reply) => {
    const sizeMultiplierGroup = (extraOptions?: { value: string; label: string }[]) => ({
      key: "size",
      label: "Ukuran",
      kind: "multiplier",
      options: [
        { value: "A5", label: "A5" },
        { value: "B5", label: "B5" },
        { value: "A4", label: "A4" },
        ...(extraOptions ?? []),
      ],
    });

    const coverGroup = (label = "Tipe Cover", options?: { value: string; label: string }[]) => ({
      key: "cover",
      label,
      kind: "multiplier",
      options: options ?? [
        { value: "SOFTCOVER", label: "Softcover" },
        { value: "HARDCOVER", label: "Hardcover" },
      ],
    });

    // BARU — dimensi "Jenis Kertas" (kind: "multiplier"), sama statusnya
    // dengan Ukuran/Cover: WAJIB dipilih, dan jadi bagian dari kombinasi
    // (dipakai juga sebagai salah satu sumbu di mode "Harga per Kombinasi").
    const paperGroup = (options?: { value: string; label: string }[]) => ({
      key: "paper",
      label: "Jenis Kertas",
      kind: "multiplier",
      options: options ?? [
        { value: "HVS", label: "HVS 70gr" },
        { value: "BOOKPAPER", label: "Bookpaper Cream" },
      ],
    });

    const pageRangeGroup = (options: { value: string; label: string }[]) => ({
      key: "pageRange",
      label: "Jumlah Halaman",
      kind: "pageBracket",
      options,
    });

    const qtyGroup = (options: { value: string; label: string }[]) => ({
      key: "qty",
      label: "Kuantitas",
      kind: "quantity",
      options: [...options, { value: "custom", label: "Custom" }],
    });

    const standardPageOptions = [
      { value: "1-50", label: "1 - 50 hlm" },
      { value: "51-100", label: "51 - 100 hlm" },
      { value: "101-150", label: "101 - 150 hlm" },
      { value: "151-200", label: "151 - 200 hlm" },
    ];
    const standardPageBracketAdd = { pageRange: { "1-50": 0, "51-100": 3000, "101-150": 6000, "151-200": 9500 } };

    const bookQtyOptions = [
      { value: "10", label: "10 - 24 pcs" },
      { value: "25", label: "25 - 49 pcs" },
      { value: "50", label: "50 - 99 pcs" },
      { value: "100", label: "100+ pcs" },
    ];
    const standardQuantityBreaks = [
      { minQty: 1, discountPercent: 0 },
      { minQty: 25, discountPercent: 5 },
      { minQty: 50, discountPercent: 10 },
      { minQty: 100, discountPercent: 15 },
    ];

    // BARU — contoh grup "Finishing Tambahan" (kind: "addon", multi-select
    // & opsional). Ini caranya masukin spek di luar kebiasaan seperti Spot
    // UV, Emboss, Jahit Benang: customer boleh centang lebih dari satu
    // sekaligus, tiap opsi punya tambahan Rp/pcs sendiri-sendiri. Angka di
    // sini CONTOH — sesuaikan lewat POST /api/admin/products atau editor.
    // BARU — contoh grup "Finishing Tambahan" (kind: "addon", multi-select
    // & opsional, pricingMode: "tiered"). Ini caranya masukin spek di luar
    // kebiasaan seperti Spot UV, Emboss, Jahit Benang, Laminating: customer
    // boleh centang lebih dari satu sekaligus, DAN harga tambahan tiap opsi
    // BEDA-BEDA per rentang kuantitas (order 10 buku kena Spot UV jauh lebih
    // mahal per-buku daripada order 500 buku, karena biaya setup plate itu
    // fixed cost yang dibagi rata ke qty). Angka di sini CONTOH — sesuaikan
    // lewat Mode Admin di app atau POST /api/admin/products.
    const finishingAddonGroup = () => ({
      key: "finishing",
      label: "Finishing Tambahan",
      kind: "addon",
      pricingMode: "tiered",
      options: [
        { value: "SPOT_UV", label: "Spot UV" },
        { value: "EMBOSS", label: "Emboss/Timbul" },
        { value: "JAHIT_BENANG", label: "Jahit Benang (Smyth Sewn)" },
        { value: "LAMINASI_DOFF", label: "Laminasi Doff" },
        { value: "LAMINASI_GLOSSY", label: "Laminasi Glossy" },
      ],
    });
    // Tier di sini mengikuti minQty yang sama dengan bookQtyOptions
    // (10/25/50/100) supaya nyambung sama chip Kuantitas yang customer lihat.
    const finishingAddonAdd = {
      finishing: {
        SPOT_UV: [
          { minQty: 10, add: 3000 },
          { minQty: 25, add: 2200 },
          { minQty: 50, add: 1500 },
          { minQty: 100, add: 900 },
        ],
        EMBOSS: [
          { minQty: 10, add: 4500 },
          { minQty: 25, add: 3500 },
          { minQty: 50, add: 2500 },
          { minQty: 100, add: 1800 },
        ],
        JAHIT_BENANG: [
          { minQty: 10, add: 2000 },
          { minQty: 25, add: 1700 },
          { minQty: 50, add: 1400 },
          { minQty: 100, add: 1000 },
        ],
        LAMINASI_DOFF: [
          { minQty: 10, add: 1500 },
          { minQty: 25, add: 1200 },
          { minQty: 50, add: 900 },
          { minQty: 100, add: 600 },
        ],
        LAMINASI_GLOSSY: [
          { minQty: 10, add: 1500 },
          { minQty: 25, add: 1200 },
          { minQty: 50, add: 900 },
          { minQty: 100, add: 600 },
        ],
      },
    };

    const products = [
      {
        slug: "buku-custom",
        name: "Buku Custom",
        category: "HM_BOOKS_PRINTING",
        badge: "On-Demand Printing",
        description: "Cetak buku satuan/tiras terbatas — pilih ukuran, jumlah halaman, dan tipe cover sesuai kebutuhan.",
        unit: "buku",
        variantGroups: [sizeMultiplierGroup(), pageRangeGroup(standardPageOptions), paperGroup(), coverGroup(), finishingAddonGroup(), qtyGroup(bookQtyOptions)],
        priceConfig: {
          baseUnitPrice: 12000,
          factors: { size: { A5: 1, B5: 1.25, A4: 1.6 }, cover: { SOFTCOVER: 1, HARDCOVER: 1.35 }, paper: { HVS: 1, BOOKPAPER: 1.1 } },
          pageBracketAdd: standardPageBracketAdd,
          addonAdd: finishingAddonAdd,
          quantityBreaks: standardQuantityBreaks,
        },
      },
      {
        slug: "buku-tahunan",
        name: "Buku Tahunan (Yearbook)",
        category: "HM_BOOKS_PRINTING",
        badge: "High Visual • Best Seller",
        description: "Cetak full color, cocok untuk SMP/SMA/Kampus. Hard cover laminating, binding kuat anti rontok.",
        unit: "buku",
        variantGroups: [sizeMultiplierGroup(), pageRangeGroup(standardPageOptions), paperGroup(), coverGroup(), finishingAddonGroup(), qtyGroup(bookQtyOptions)],
        priceConfig: {
          baseUnitPrice: 45000,
          factors: { size: { A5: 1, B5: 1.2, A4: 1.5 }, cover: { SOFTCOVER: 1, HARDCOVER: 1.35 }, paper: { HVS: 1, BOOKPAPER: 1.1 } },
          pageBracketAdd: standardPageBracketAdd,
          addonAdd: finishingAddonAdd,
          quantityBreaks: standardQuantityBreaks,
        },
      },
      {
        slug: "notebook",
        name: "Notebook / Buku Catatan Custom",
        category: "HM_BOOKS_PRINTING",
        badge: "Corporate Gift • Merchandise",
        description: "Notebook custom cover & isi, cocok untuk merchandise perusahaan atau seminar kit.",
        unit: "pcs",
        variantGroups: [
          sizeMultiplierGroup(),
          pageRangeGroup([
            { value: "1-50", label: "1 - 50 lbr" },
            { value: "51-100", label: "51 - 100 lbr" },
            { value: "101-150", label: "101 - 150 lbr" },
          ]),
          coverGroup(),
          qtyGroup(bookQtyOptions),
        ],
        priceConfig: {
          baseUnitPrice: 15000,
          factors: { size: { A5: 1, B5: 1.15, A4: 1.35 }, cover: { SOFTCOVER: 1, HARDCOVER: 1.3 } },
          pageBracketAdd: { pageRange: { "1-50": 0, "51-100": 2500, "101-150": 5000 } },
          quantityBreaks: standardQuantityBreaks,
        },
      },
      {
        slug: "yasin",
        name: "Buku Yasin & Tahlil",
        category: "HM_BOOKS_PRINTING",
        badge: "Hardcover & Hot Print",
        description: "Cetak buku yasin kenangan tahlilan, cover kain bludru/hot print emas-perak atau kulit sintetis premium.",
        unit: "pcs",
        variantGroups: [
          sizeMultiplierGroup(),
          pageRangeGroup([
            { value: "1-40", label: "1 - 40 hlm" },
            { value: "41-80", label: "41 - 80 hlm" },
          ]),
          coverGroup("Tipe Cover", [
            { value: "SOFTCOVER", label: "Kain Bludru (Hot Print)" },
            { value: "HARDCOVER", label: "Kulit Sintetis Premium" },
          ]),
          qtyGroup(bookQtyOptions),
        ],
        priceConfig: {
          baseUnitPrice: 8500,
          factors: { size: { A5: 1, B5: 1.1, A4: 1.25 }, cover: { SOFTCOVER: 1, HARDCOVER: 1.3 } },
          pageBracketAdd: { pageRange: { "1-40": 0, "41-80": 2000 } },
          quantityBreaks: standardQuantityBreaks,
        },
      },
      {
        slug: "undangan",
        name: "Undangan Pernikahan & Event Custom",
        category: "HM_BOOKS_PRINTING",
        badge: "Full Finishing",
        description: "Undangan cetak kilat, art carton tebal & pilihan laminasi/finishing mewah. (Tidak ada dimensi halaman — produk lembaran).",
        unit: "lbr",
        variantGroups: [
          sizeMultiplierGroup(),
          coverGroup("Jenis Finishing", [
            { value: "SOFTCOVER", label: "Laminasi Doff" },
            { value: "HARDCOVER", label: "Emboss + Laminasi Premium" },
          ]),
          qtyGroup([
            { value: "50", label: "50 - 99 lbr" },
            { value: "100", label: "100 - 249 lbr" },
            { value: "250", label: "250+ lbr" },
          ]),
        ],
        priceConfig: {
          baseUnitPrice: 1500,
          factors: { size: { A5: 1, B5: 1.15, A4: 1.3 }, cover: { SOFTCOVER: 1, HARDCOVER: 1.5 } },
          quantityBreaks: [
            { minQty: 1, discountPercent: 0 },
            { minQty: 100, discountPercent: 8 },
            { minQty: 250, discountPercent: 15 },
          ],
        },
      },
      {
        slug: "id-card",
        name: "ID Card Custom",
        category: "HM_BOOKS_PRINTING",
        badge: "PVC Print • Karyawan/Member/Event",
        description: "Cetak ID card PVC custom desain, cocok untuk karyawan, member, panitia event. (Ukuran standar CR80 — tidak ada dimensi halaman).",
        unit: "pcs",
        variantGroups: [
          {
            key: "material",
            label: "Bahan",
            kind: "multiplier",
            options: [
              { value: "PVC_STANDAR", label: "PVC Standar" },
              { value: "PVC_RFID", label: "PVC + Chip RFID" },
            ],
          },
          {
            key: "sisi",
            label: "Sisi Cetak",
            kind: "multiplier",
            options: [
              { value: "SATU_SISI", label: "1 Sisi" },
              { value: "DUA_SISI", label: "2 Sisi" },
            ],
          },
          qtyGroup([
            { value: "25", label: "25 - 49 pcs" },
            { value: "50", label: "50 - 99 pcs" },
            { value: "100", label: "100+ pcs" },
          ]),
        ],
        priceConfig: {
          baseUnitPrice: 5000,
          factors: {
            material: { PVC_STANDAR: 1, PVC_RFID: 3.2 },
            sisi: { SATU_SISI: 1, DUA_SISI: 1.3 },
          },
          quantityBreaks: [
            { minQty: 1, discountPercent: 0 },
            { minQty: 50, discountPercent: 8 },
            { minQty: 100, discountPercent: 15 },
          ],
        },
      },
    ];

    const results: { slug: string; name: string }[] = [];
    for (const p of products) {
      await prisma.product.upsert({
        where: { slug: p.slug },
        create: p as any,
        update: p as any,
      });
      results.push({ slug: p.slug, name: p.name });
    }

    return reply.send({
      message: `${results.length} produk kategori HM Books & Printing dibuat/diperbarui. SEMUA HARGA MASIH CONTOH — cek & sesuaikan lewat POST /api/admin/products sebelum dipakai customer beneran.`,
      products: results,
    });
  });
}
