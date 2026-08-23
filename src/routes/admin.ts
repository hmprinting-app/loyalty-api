import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { addPoints, redeemForNota } from "../lib/points";
import { TxType } from "@prisma/client";
import { generateUniqueReferralCode } from "../lib/referral-code";
import { calcTier } from "../lib/tier";

const ADMIN_TYPES: TxType[] = ["EARN_MANUAL", "EARN_TRANSITION", "ADJUSTMENT"];

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

  // ============================================================
  // BARU: Potong nota pakai poin (dipanggil admin saat konfirmasi order,
  // baik manual maupun nanti otomatis dari sistem Kanban)
  // ============================================================
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
  // BARU: dukung referredByCode -> kalau valid, member baru dapat 50 poin
  // welcome bonus referral (terpisah dari welcome bonus login 500 poin
  // untuk member lama - lihat catatan welcomeBonusClaimed di bawah).
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
          // Member yang daftar via referral dianggap signup ORGANIK BARU,
          // bukan migrasi customer lama -> welcomeBonusClaimed langsung true
          // biar tidak dobel dapat welcome bonus 500 poin login legacy.
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

  app.get<{ Params: { phone: string } }>("/api/admin/members/:phone", async (req, reply) => {
    const member = await prisma.member.findUnique({
      where: { phone: req.params.phone },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 20 } },
    });
    if (!member) return reply.code(404).send({ error: "Tidak ditemukan" });
    return reply.send(member);
  });

  // ============================================================
  // BARU: Approve / Reject Cashout Request
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

      const updated = await prisma.$transaction(async (tx) => {
        const rejected = await tx.cashoutRequest.update({
          where: { id: cashout.id },
          data: { status: "rejected", processedAt: new Date(), adminNote: req.body?.adminNote },
        });
        // Kembalikan poin yang sempat dikunci ke saldo member
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
  // BARU: Upload metadata file master (Cloud Storage Preview)
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
  // BARU (pengganti script CLI): Backfill tier & referralCode
  // Aman dipanggil BERKALI-KALI (idempotent) — hanya menyentuh member yang
  // tier-nya masih pakai value lama (BRONZE_PAPER/SILVER_IVORY/GOLD_FOIL)
  // atau belum punya referralCode.
  // ============================================================
  app.post("/api/admin/maintenance/backfill-tier-referral", async (req, reply) => {
    const legacyTierMap: Record<string, void> = {};
    const membersToFix = await prisma.member.findMany({
      where: {
        OR: [
          { tier: { in: ["BRONZE_PAPER", "SILVER_IVORY", "GOLD_FOIL"] } },
          { referralCode: null },
        ],
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

    // Sekalian migrasi tierMin di voucher lama ke value baru yang setara
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
  // BARU (pengganti script CLI, Poin 6): Campaign "Jumat Berkah"
  // Body: { bulkBuyerPhones?: string[], bulkUserIds?: string[], dryRun?: boolean }
  // Kasih 50 poin ke SEMUA member yang belum pernah dapat poin sama sekali
  // (lifetimePoints === 0 && spendablePoints === 0), atau 500 poin kalau
  // termasuk bulk buyer (dicocokkan via nomor HP ATAU Member ID).
  //
  // Diproses per BATCH 100 member (concurrent di dalam batch, berurutan
  // antar batch) supaya aman untuk ribuan member tanpa timeout ke Postgres
  // Railway. Kegagalan pada satu member TIDAK menggagalkan seluruh batch —
  // dicatat di `failures` agar bisa di-retry manual.
  // ============================================================
  app.post<{ Body: { bulkBuyerPhones?: string[]; bulkUserIds?: string[]; dryRun?: boolean } }>(
    "/api/admin/campaigns/jumat-berkah",
    async (req, reply) => {
      const bulkBuyerPhones = new Set(req.body?.bulkBuyerPhones ?? []);
      const bulkUserIds = new Set(req.body?.bulkUserIds ?? []);
      const dryRun = req.body?.dryRun ?? false;
      const BATCH_SIZE = 100;

      const eligibleMembers = await prisma.member.findMany({
        where: { lifetimePoints: 0, spendablePoints: 0 },
      });

      const succeeded: { id: string; name: string; phone: string; bonus: number; isBulkBuyer: boolean }[] = [];
      const failures: { id: string; name: string; phone: string; error: string }[] = [];

      // Bagi jadi batch 100 member per grup
      for (let i = 0; i < eligibleMembers.length; i += BATCH_SIZE) {
        const batch = eligibleMembers.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (member) => {
            const isBulkBuyer = bulkBuyerPhones.has(member.phone) || bulkUserIds.has(member.id);
            const bonus = isBulkBuyer ? 500 : 50;

            try {
              if (!dryRun) {
                await addPoints({
                  memberId: member.id,
                  basePoints: bonus,
                  type: "EARN_MANUAL",
                  note: isBulkBuyer ? "Jumat Berkah - Bulk Buyer" : "Jumat Berkah - Welcome Bonus",
                  createdBy: "system-jumat-berkah",
                });
              }
              succeeded.push({ id: member.id, name: member.name, phone: member.phone, bonus, isBulkBuyer });
            } catch (err: any) {
              failures.push({ id: member.id, name: member.name, phone: member.phone, error: err.message ?? "Unknown error" });
            }
          }),
        );
      }

      return reply.send({
        dryRun,
        totalEligible: eligibleMembers.length,
        totalBatches: Math.ceil(eligibleMembers.length / BATCH_SIZE),
        succeededCount: succeeded.length,
        failedCount: failures.length,
        normalBonusCount: succeeded.filter((r) => !r.isBulkBuyer).length,
        bulkBuyerBonusCount: succeeded.filter((r) => r.isBulkBuyer).length,
        failures,
        message: dryRun
          ? "Ini DRY RUN — kirim ulang dengan dryRun:false untuk benar-benar kasih poin."
          : failures.length > 0
            ? `Selesai dengan ${failures.length} kegagalan — cek field "failures" untuk detail & retry manual.`
            : "Selesai! Semua member eligible sudah dapat poin tanpa error.",
      });
    },
  );
}
