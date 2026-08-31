import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import authRoutes from "./routes/auth";
import memberRoutes from "./routes/member";
import voucherRoutes from "./routes/vouchers";
import adminRoutes from "./routes/admin";
import catalogRoutes from "./routes/catalog";
import notaRedeemRequestRoutes from "./routes/nota-redeem-requests";
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: any, reply: any) => Promise<void>;
  }
}
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { memberId: string };
    user: { memberId: string };
  }
}
async function main() {
  const app = Fastify({ logger: true });
  // Fix: Fastify default nolak request kalau Content-Type: application/json
// tapi body-nya kosong (misal endpoint yang cuma butuh :id dari URL params,
// kayak POST /api/vouchers/:id/redeem). Override parser biar body kosong
// dianggap {} alih-alih throw FST_ERR_CTP_EMPTY_JSON_BODY.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  function (req, body: string, done) {
    if (!body || body.trim() === "") {
      done(null, {});
      return;
    }
    try {
      const json = JSON.parse(body);
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  }
);
  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? "*").split(","),
    credentials: true,
  });
  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  });
  app.decorate("authenticate", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized - login lagi ya" });
    }
  });
  app.get("/health", async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(memberRoutes);
  await app.register(voucherRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(notaRedeemRequestRoutes);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`loyalty-api jalan di port ${port}`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
