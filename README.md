# loyalty-api — HM Printing VIP Club

Backend loyalty program. Fastify + Prisma + PostgreSQL, deploy di Railway.

## Setup lokal (sekali di awal)

```powershell
npm install
copy .env.example .env
# edit .env: isi JWT_SECRET, ADMIN_SECRET pakai string acak
```

## Deploy ke Railway

1. Buat repo baru di GitHub org `hmprinting-app`, misal `loyalty-api`. Push semua file ini ke situ.
2. Di Railway: **New Project → Deploy from GitHub repo** → pilih `loyalty-api`.
3. Tambah plugin **PostgreSQL** di project yang sama (Railway otomatis kasih `DATABASE_URL`).
4. Di tab **Variables** service `loyalty-api`, tambahkan:
   - `JWT_SECRET` — string acak panjang
   - `ADMIN_SECRET` — string acak panjang (dipakai buat proteksi endpoint admin)
   - `CORS_ORIGIN` — `https://vip.hmprinting.id`
   - `FRONTEND_URL` — `https://vip.hmprinting.id`
   - `WELCOME_BONUS_POINTS` — `500` (atau sesuai keputusan bisnis)
   - `DATABASE_URL` biasanya udah otomatis ke-link dari plugin Postgres, tinggal cek ada.
5. Railway otomatis jalanin `npm run build` lalu `npm start` (dari `package.json`). Build step ini juga generate Prisma client.
6. **Migrate database** — dari Railway CLI di PowerShell:
   ```powershell
   railway link
   railway run npx prisma migrate deploy
   railway run npx prisma db seed
   ```
   (Kalau `railway run` bermasalah di PowerShell, connect pakai `railway connect "Postgres-xxxx"` terus jalankan migration lewat situ, sesuai catatan kamu sebelumnya.)
7. Cek `https://<service>.up.railway.app/health` → harus balas `{"ok":true}`.
8. (Opsional tapi disarankan) Tambah custom domain `api.hmprinting.id` atau `api-vip.hmprinting.id` di tab Settings → Domains, arahkan CNAME di Cloudflare.

## Import 3000+ kontak WA lama

```powershell
npm run import-members -- scripts/contacts.csv
```

Hasilnya: `scripts/import-output.csv` berisi `phone,name,link,status` — file inilah
yang dipakai buat WA blast (tiap orang dapet link personal masing-masing).

⚠️ Jalankan **sekali** dari environment yang connect ke database production
(pakai `railway run npm run import-members -- ...` biar `DATABASE_URL`-nya benar).

## Endpoint ringkas

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| POST | `/api/auth/login` | - | Body `{token}`, return `{jwt, member}` |
| GET | `/api/member/me` | Bearer JWT | Profil + poin + tier |
| GET | `/api/member/transactions` | Bearer JWT | Riwayat poin |
| GET | `/api/vouchers` | Bearer JWT | List voucher aktif |
| POST | `/api/vouchers/:id/redeem` | Bearer JWT | Tukar poin |
| POST | `/api/admin/points/add` | `x-admin-secret` | Tambah poin manual |
| POST | `/api/admin/members` | `x-admin-secret` | Buat member + link baru |
| GET | `/api/admin/members` | `x-admin-secret` | List member |
