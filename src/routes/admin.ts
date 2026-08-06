import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { addPoints } from "../lib/points";
import { TxType } from "@prisma/client";

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

  // Buat 1 member baru + magic link-nya (dipakai juga oleh script bulk-import)
  app.post<{ Body: { phone: string; name: string } }>("/api/admin/members", async (req, reply) => {
    const { phone, name } = req.body;
    if (!phone || !name) return reply.code(400).send({ error: "phone & name wajib diisi" });

    const existing = await prisma.member.findUnique({ where: { phone } });
    if (existing) return reply.code(409).send({ error: "Member sudah terdaftar", member: existing });

    const member = await prisma.member.create({ data: { phone, name } });
    return reply.send({
      member,
      personalLink: `${process.env.FRONTEND_URL ?? "https://vip.hmprinting.id"}/index.html?t=${member.magicToken}`,
    });
  });

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
}
