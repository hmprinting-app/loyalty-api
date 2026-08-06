/**
 * Import kontak WA lama (3000+) jadi Member + generate magic link tiap orang.
 *
 * Cara pakai:
 *   1. Siapkan file CSV dengan 2 kolom: phone,name
 *      (phone format 628xxxxxxxxxx, tanpa spasi/simbol)
 *   2. Taruh file itu di folder ini, misal: scripts/contacts.csv
 *   3. Jalankan: npm run import-members -- scripts/contacts.csv
 *   4. Hasilnya keluar file scripts/import-output.csv berisi phone,name,link
 *      -> file ini yang dipakai buat WA blast (link personal tiap member)
 *
 * Member yang nomornya sudah terdaftar akan DI-SKIP (tidak dibuat ulang / tidak reset poin).
 */
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { prisma } from "../src/lib/prisma";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://vip.hmprinting.id";

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Pakai: npm run import-members -- path/ke/contacts.csv");
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(inputPath), "utf-8");
  const rows: { phone: string; name: string }[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  console.log(`Ditemukan ${rows.length} baris kontak.`);

  const output: string[] = ["phone,name,link,status"];
  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    const phone = row.phone.replace(/\D/g, ""); // buang karakter non-digit
    const name = row.name?.trim() || "Member HM Printing";

    if (!phone) {
      output.push(`${row.phone},${name},,SKIP_INVALID_PHONE`);
      skipped++;
      continue;
    }

    const existing = await prisma.member.findUnique({ where: { phone } });
    if (existing) {
      const link = `${FRONTEND_URL}/index.html?t=${existing.magicToken}`;
      output.push(`${phone},${name},${link},ALREADY_EXISTS`);
      skipped++;
      continue;
    }

    const member = await prisma.member.create({ data: { phone, name } });
    const link = `${FRONTEND_URL}/index.html?t=${member.magicToken}`;
    output.push(`${phone},${name},${link},CREATED`);
    created++;
  }

  const outPath = path.resolve(__dirname, "import-output.csv");
  fs.writeFileSync(outPath, output.join("\n"));

  console.log(`Selesai. Dibuat: ${created}, dilewati: ${skipped}.`);
  console.log(`Hasil (buat WA blast) ada di: ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
