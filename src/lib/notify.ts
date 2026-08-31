// src/lib/notify.ts
//
// Kirim notifikasi WA ke nomor admin (Bos CH) via Fonnte, dipakai untuk
// event-event penting yang perlu diketahui real-time (misal: ada customer
// tukar poin voucher).
//
// PENTING — desain ini SENGAJA non-blocking & fail-safe:
//   - TIDAK di-await sampai selesai oleh pemanggil (fire-and-forget)
//   - Kalau Fonnte down/error/timeout, cuma di-log ke console, TIDAK PERNAH
//     melempar error ke pemanggil
// Alasannya: notifikasi WA ke admin adalah "best effort", bukan bagian
// krusial dari transaksi. Kegagalan kirim notif TIDAK BOLEH membatalkan
// atau menahan proses utama (redeem poin, potong nota, dll).

export function notifyAdminWA(message: string): void {
  const token = process.env.FONNTE_TOKEN;
  const target = process.env.ADMIN_WA_NUMBER;

  if (!token || !target) {
    console.warn(
      "[notifyAdminWA] FONNTE_TOKEN atau ADMIN_WA_NUMBER belum di-set di environment variables — notif WA di-skip.",
    );
    return;
  }

  const body = new URLSearchParams();
  body.append("target", target);
  body.append("message", message);

  fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: {
      Authorization: token,
    },
    body,
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[notifyAdminWA] Fonnte merespons status ${res.status}: ${text}`);
      }
    })
    .catch((err) => {
      console.error("[notifyAdminWA] Gagal kirim notif WA ke admin:", err);
    });
}
