import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const vouchers = [
    { title: "Diskon 10% Semua Produk", costPoints: 2500, stock: 45, minSpend: "Min. belanja Rp 250.000", code: "VIP10HM", tierMin: null },
    { title: "Potongan Langsung Rp 25.000", costPoints: 5000, stock: 30, minSpend: "Min. belanja Rp 250.000", code: "POT25K", tierMin: null },
    { title: "Gratis Ongkir Seluruh Jawa", costPoints: 1000, stock: 99, minSpend: "Min. belanja Rp 150.000", code: "FREESHIP", tierMin: null },
    { title: "Voucher Spesial Gold Foil (Diskon 20%)", costPoints: 10000, stock: 10, minSpend: "Min. belanja Rp 500.000", code: "GOLD20HM", tierMin: "GOLD_FOIL" as const },
  ];

  for (const v of vouchers) {
    const existing = await prisma.voucher.findFirst({ where: { code: v.code } });
    if (!existing) {
      await prisma.voucher.create({ data: v });
      console.log(`Voucher dibuat: ${v.title}`);
    } else {
      console.log(`Voucher sudah ada, dilewati: ${v.title}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
