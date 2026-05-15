# IrO WhatsApp Bot

Bot WhatsApp pribadi berbasis Baileys. Login memakai QR di terminal, command memakai prefix koma, dan akun yang sedang login menjadi owner/superuser bot.

## Ringkas

- Cocok dipindah ke Linux atau Windows lain.
- Data runtime berada di `data/`, credential di `.env` dan `auth/`.
- Tool sistem opsional dipakai untuk fitur media dan PDF.
- Backup `data/` bisa dikirim ke Telegram Bot API.

## Persiapan

Wajib:

- Node.js `>= 20`
- npm

Opsional untuk fitur penuh:

- `ffmpeg`
- `ffprobe`
- `libreoffice` atau `soffice`

## Setup Cepat

```bash
npm run setup
```

Jika PowerShell Windows memblokir `npm` karena execution policy:

```powershell
npm.cmd run setup
```

Setup dan startup bot akan membuat folder runtime, `.env`, `data/config.json`, dan file JSON awal seperti `command-access`, `tasks`, `notes`, `links`, `reminders`, dan `wol` jika hilang. Jika `.env` sudah ada tetapi ada key wajib yang belum ada, key itu akan ditambahkan tanpa menimpa nilai lama.

Penting:

- Isi `.env` sebelum memakai `,backup`.
- Cek `data/config.json` bila nama grup target bukan `IrOBot`.
- Isi `LINUX_SUDO_PASSWORD` di `.env` jika `,update` perlu restart service systemd lewat sudo.

Untuk mencoba memasang tool sistem otomatis:

```bash
npm run setup:full
```

## Konfigurasi

`.env`:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CLIENT_ID=
LINUX_SUDO_PASSWORD=
TELEGRAM_PART_SIZE_MB=45
```

`data/config.json` dibuat dari `config.example.json` dan berisi target grup, default sticker, nama PDF default, WOL broadcast/port, timeout sesi, backup otomatis, dan setting update/restart service.

## Cek Kesiapan

```bash
npm run doctor
npm run check
npm test
```

## Jalankan Bot

```bash
npm start
```

Scan QR yang muncul di terminal. Session WhatsApp disimpan di `auth/`.

## Command

- Media: `,s [title][,author]`, `,smeme up/down <teks> [1-99]`, `,rs`, `,topdf [nama]`
- ⏰ Reminder/task: `,task`, `,ltask`, `,ltask true|false|del <id>`, `,remindme <teks> <durasi>`
- 💾 Save: `,save`, `,load`, `,load <id|judul>`, `,load del <id|judul>`, `,load change <id|judul> <judul-baru>`
- 📝 Note/link: `,note`, `,note del <id|judul>`, `,link`, `,link del <id|nama>`
- Utility: `,info`, `,status`, `,health`, `,won`, `,backup`, `,restore`, `,clear`, `,update`, `,restartbot`, `,allow`
- ✅ Session: `,end`, `,cancel`, `,confirm`

## Catatan Fitur

View-once/media:

- Reply media atau view-once lalu ketik `,rs`.
- Bot mengirim media itu kembali ke chat tempat command dijalankan.
- Jika `,rs` dipakai pada sticker, sticker statis dikirim sebagai PNG dan sticker bergerak dikirim sebagai GIF.
- Reply media lalu kirim teks yang berakhir spasi titik, contoh `halo .`, untuk mengirim media ke grup target `IrOBot`.
- Teks sebelum ` .` dipakai sebagai caption baru jika media mendukung caption.
- Ubah nama target di `data/config.json` bila perlu.

Smeme:

- Reply image, GIF, video, sticker statis, atau sticker bergerak lalu ketik `,smeme up teks` atau `,smeme down teks`.
- Tambahkan angka `1-99` di akhir untuk mengubah resolusi kerja dari default 512px, contoh `,smeme down halo dunia 80`.
- Style teks meme bisa diubah dari konstanta `SMEME_STYLE` di `src/sticker.js`.

Sticker:

- `,s judul sticker,author sticker` memakai pemisah koma untuk author.
- `,s judul sticker` memakai title custom dan author default dari config.

Operasional:

- Owner adalah akun WhatsApp yang sedang login.
- `,allow here true|false` membuka/menutup akses publik di chat/grup tempat command dikirim.
- `,allow all true|false` membuka/menutup akses publik di semua chat/grup.
- Akses publik hanya berlaku untuk `,s`, `,smeme`, dan `,rs`.

PDF:

- Ketik `,topdf` atau `,topdf laporan`.
- Kirim/reply beberapa media atau dokumen.
- Caption/teks angka dipakai sebagai urutan PDF.
- Jika nomor sudah terisi, bot memberi warning dan media tidak ditambahkan.
- Teks bebas tetap masuk urutan otomatis.
- Ketik `,end` untuk membuat PDF.

Save/load:

- Judul `,save`, `,note`, dan `,link` wajib unik.
- Judul dengan spasi bisa memakai quote, contoh: `,save "judul panjang"`.

Reminder:

- `,remindme minum 10m`
- Durasi mendukung `10s`, `5m`, `2h`, `1d`, dan `1h30m`.
- Reminder dikirim ke grup target `IrOBot`.

Backup/restore:

- `,backup` membuat zip folder `data/` dan mengirimnya ke Telegram client id di `.env`.
- Backup otomatis berjalan setiap `00:00` WIB secara default dengan mekanisme yang sama seperti `,backup`.
- Jika zip terlalu besar, bot mengirim part seperti `PART1-2026-05-15-18_12_49.zip`.
- `,restore` dimulai dari WhatsApp, lalu kirim file zip/part sebagai dokumen.
- Setelah semua part terkirim, ketik `,end`, lalu `,confirm`; folder `data/` akan ditimpa dari isi zip.
- Backup tidak mencakup `auth/`, `.env`, `logs/`, atau `temp/`.

Konfirmasi:

- Aksi hapus, `,clear`, final `,restore`, `,update`, dan `,restartbot` wajib dikonfirmasi dengan `,confirm`.
- Ketik `,cancel` untuk membatalkan konfirmasi pending atau sesi aktif.

Update/restart:

- `,restartbot` melakukan graceful exit.
- `,update` menjalankan `git pull origin main`, lalu restart service systemd.
- Jika restart systemd butuh authentication, bot mencoba `sudo -S systemctl` memakai `LINUX_SUDO_PASSWORD` dari `.env`.
- Default service systemd adalah `irobot-wa.service`; ubah di `data/config.json` bagian `update.systemdService`.
- Agar bot benar-benar hidup lagi, jalankan lewat supervisor seperti PM2, systemd, nodemon, atau service manager lain.

## Fitur yang Bergantung Tool Sistem

- Sticker/media dan sebagian konversi: butuh `ffmpeg`.
- Office ke PDF: butuh `libreoffice` atau `soffice`.

Bot tetap bisa start tanpa tool tersebut. Command yang membutuhkan tool hilang akan memberi pesan error yang jelas.

## Pindah Device

1. Clone/copy project.
2. Jalankan `npm run setup`.
3. Isi `.env` dan cek `data/config.json`.
4. Jalankan `npm run doctor`.
5. Jalankan `npm start`.
6. Scan QR bila folder `auth/` tidak ikut dipindah.

Jangan upload `auth/`, `.env`, `logs/`, `temp/`, atau file runtime `data/*.json` pribadi ke GitHub.
