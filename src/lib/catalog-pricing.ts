// ============================================================================
// src/lib/catalog-pricing.ts
// Mesin hitung harga generik berbasis kombinasi varian (Shopee-style).
// SENGAJA generik/config-driven (bukan hardcode per produk) supaya 1 fungsi
// ini bisa dipakai untuk SEMUA produk di kategori HM_BOOKS_PRINTING, apapun
// kombinasi variant group-nya (Buku Custom/Tahunan/Notebook/Yasin dengan 4
// dimensi Ukuran+Halaman+Cover+Kuantitas, ATAU Undangan/ID Card yang cuma
// butuh sebagian dimensi itu — skip yang nggak relevan).
//
// PENTING: rumus di fungsi ini HARUS SAMA PERSIS dengan yang dipakai di
// index.html (fungsi calculateProductPriceJS) supaya harga yang tampil di
// PWA (real-time saat klik chip) selalu identik dengan hasil verifikasi
// server saat tombol "Pesan via WhatsApp" diklik. Kalau salah satu diubah,
// yang satunya WAJIB ikut diubah.
// ============================================================================

// "addon" (BARU) — beda dari 3 kind lain: MULTI-SELECT (customer boleh
// centang lebih dari satu sekaligus), dipakai untuk spek tambahan di luar
// kebiasaan yang sifatnya opsional & bisa ditumpuk, misalnya:
//   Spot UV (+Rp2.000/pcs), Emboss (+Rp3.500/pcs), Jahit Benang (+Rp1.500/pcs)
// Beda dengan "multiplier"/"pageBracket" yang single-select (pilih 1 dari
// beberapa opsi wajib), "addon" itu opsional & bisa 0/1/banyak dipilih.
export type VariantGroupKind = "multiplier" | "pageBracket" | "quantity" | "addon";

export interface VariantOption {
  value: string;
  label: string;
}

export interface VariantGroup {
  key: string;
  label: string;
  kind: VariantGroupKind;
  options: VariantOption[];
}

export interface QuantityBreak {
  minQty: number;
  discountPercent: number;
}

export interface PriceConfig {
  baseUnitPrice: number;
  factors?: Record<string, Record<string, number>>; // [groupKey][value] -> multiplier
  pageBracketAdd?: Record<string, Record<string, number>>; // [groupKey][value] -> tambahan Rp
  addonAdd?: Record<string, Record<string, number>>; // [groupKey][value] -> tambahan Rp per pcs (kind "addon")
  quantityBreaks: QuantityBreak[]; // urut naik berdasarkan minQty
}

export interface ProductLike {
  variantGroups: VariantGroup[];
  priceConfig: PriceConfig;
}

export interface PriceBreakdownLine {
  groupKey: string;
  label: string;
  selectedLabel: string;
  effect: string; // deskripsi singkat efeknya ke harga, buat ditampilkan di UI
}

export interface PriceResult {
  unitPrice: number;
  qty: number;
  totalBeforeDiscount: number;
  discountPercent: number;
  discountAmount: number;
  totalAfterDiscount: number;
  breakdown: PriceBreakdownLine[];
}

export class InvalidVariantSelectionError extends Error {}

/**
 * Hitung harga akhir berdasarkan produk (variantGroups + priceConfig) dan
 * pilihan customer. `selection` adalah object { [groupKey]: value } untuk
 * group single-select (multiplier/pageBracket), TAPI untuk group "addon"
 * (finishing tambahan, multi-select) valuenya berupa ARRAY of string, misal
 * `selection.finishing = ["SPOT_UV", "EMBOSS"]` (boleh kosong `[]` kalau
 * customer nggak pilih finishing tambahan apapun — ini SATU-SATUNYA kind
 * yang boleh kosong, sisanya wajib diisi). `qty` adalah angka pcs/buku/lbr
 * final (hasil dari chip preset ATAU input custom).
 */
export function calculateProductPrice(
  product: ProductLike,
  selection: Record<string, string | string[]>,
  qty: number,
): PriceResult {
  if (!qty || qty <= 0) {
    throw new InvalidVariantSelectionError("Kuantitas harus lebih dari 0");
  }

  let unitPrice = product.priceConfig.baseUnitPrice;
  const breakdown: PriceBreakdownLine[] = [];

  for (const group of product.variantGroups) {
    if (group.kind === "quantity") continue; // qty ditangani terpisah di bawah

    if (group.kind === "addon") {
      // Multi-select & opsional — boleh array kosong, TIDAK error kalau kosong.
      const rawValues = selection[group.key];
      const values = Array.isArray(rawValues) ? rawValues : rawValues ? [rawValues] : [];
      for (const value of values) {
        const option = group.options.find((o) => o.value === value);
        if (!option) continue; // abaikan value asing daripada bikin seluruh order gagal
        const add = product.priceConfig.addonAdd?.[group.key]?.[value] ?? 0;
        unitPrice += add;
        breakdown.push({
          groupKey: group.key,
          label: group.label,
          selectedLabel: option.label,
          effect: add === 0 ? "tidak ada tambahan biaya" : `+Rp${add.toLocaleString("id-ID")}/pcs`,
        });
      }
      continue;
    }

    const value = selection[group.key];
    const option = group.options.find((o) => o.value === value);
    if (!option) {
      throw new InvalidVariantSelectionError(
        `Pilihan "${group.label}" wajib diisi (dapat: ${value ?? "kosong"})`,
      );
    }

    if (group.kind === "multiplier") {
      const factor = product.priceConfig.factors?.[group.key]?.[value as string] ?? 1;
      unitPrice *= factor;
      breakdown.push({
        groupKey: group.key,
        label: group.label,
        selectedLabel: option.label,
        effect: factor === 1 ? "tidak ada tambahan biaya" : `×${factor}`,
      });
    } else if (group.kind === "pageBracket") {
      const add = product.priceConfig.pageBracketAdd?.[group.key]?.[value as string] ?? 0;
      unitPrice += add;
      breakdown.push({
        groupKey: group.key,
        label: group.label,
        selectedLabel: option.label,
        effect: add === 0 ? "tidak ada tambahan biaya" : `+Rp${add.toLocaleString("id-ID")}/pcs`,
      });
    }
  }

  unitPrice = Math.round(unitPrice);
  const totalBeforeDiscount = unitPrice * qty;

  // Cari bracket diskon grosir tertinggi yang qty-nya masih memenuhi minQty
  const sortedBreaks = [...product.priceConfig.quantityBreaks].sort((a, b) => a.minQty - b.minQty);
  let discountPercent = 0;
  for (const brk of sortedBreaks) {
    if (qty >= brk.minQty) discountPercent = brk.discountPercent;
  }

  const discountAmount = Math.round((totalBeforeDiscount * discountPercent) / 100);
  const totalAfterDiscount = totalBeforeDiscount - discountAmount;

  return {
    unitPrice,
    qty,
    totalBeforeDiscount,
    discountPercent,
    discountAmount,
    totalAfterDiscount,
    breakdown,
  };
}
