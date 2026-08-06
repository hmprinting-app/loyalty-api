import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import authRoutes from "./routes/auth";
import memberRoutes from "./routes/member";
import voucherRoutes from "./routes/vouchers";
import adminRoutes from "./routes/admin";

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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`loyalty-api jalan di port ${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
