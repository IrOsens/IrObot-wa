# IrO WhatsApp Bot

Bot WhatsApp pribadi berbasis Baileys. Login memakai QR di terminal, command memakai prefix koma, dan akun yang sedang login menjadi owner/superuser bot.

## Ringkas

- Cocok dipindah ke Linux atau Windows lain.
- Data runtime berada di `data/`, credential di `.env` dan `auth/`.
- Tool sistem opsional dipakai untuk fitur media dan PDF.
- Backup `data/` dikirim ke destination WhatsApp `backup`.

## Persiapan

Wajib:

- Node.js `>= 20`
- npm

Opsional untuk fitur penuh:

- `ffmpeg`
- `ffprobe`
- `libreoffice` atau `soffice`
- `pdftoppm` dari Poppler atau ImageMagick `magick` untuk fallback `,toimg`

## Setup Cepat

```bash
npm run setup
```

Jika PowerShell Windows memblokir `npm` karena execution policy:

```powershell
npm.cmd run setup
```

Setup dan startup bot akan membuat folder runtime, `.env`, `data/config.json`, dan file JSON awal seperti `bot-state`, `command-access`, `changed-messages`, `status-save`, `tasks`, `notes`, `links`, `reminders`, dan `wol` jika hilang.

Penting:

- Cek `data/config.json` atau pakai `,config` bila nama grup target/default bukan `IrOBot`, `logs`, `changedmsg`, `saved`, atau `backup`.
- Isi `LINUX_SUDO_PASSWORD` di `.env` jika `,update` perlu restart service systemd lewat sudo.

Untuk mencoba memasang tool sistem otomatis:

```bash
npm run setup:full
```

## Konfigurasi

`.env`:

```env
YOUTUBE_COOKIE_FILE=auth/youtube-cookies.txt
YOUTUBE_EXTRACTOR_ARGS=
YOUTUBE_PO_TOKEN=
LINUX_SUDO_PASSWORD=
BACKUP_PART_SIZE_MB=45
```

`data/config.json` dibuat dari `config.example.json` dan berisi target grup, default sticker, nama PDF default, WOL broadcast/port, timeout sesi, destination `logs/changedmsg/saved/backup`, backup otomatis, dan setting update/restart service. Owner bisa melihat/mengubah key aman dengan `,config`.

## Cek Kesiapan

```bash
npm run doctor
npm run check
npm test
```

Di PowerShell Windows, gunakan `npm.cmd run check` dan `npm.cmd test` bila `npm.ps1` diblokir.

## Jalankan Bot

```bash
npm start
```

Scan QR yang muncul di terminal. Session WhatsApp disimpan di `auth/`.

## Command

- Media: `,s [title][,author]`, `,smeme up/down <teks> [1-99]`, `,rs`, `,topdf [split] [nama][,1MB]`, `,toimg`
- Reminder/task: `,task`, `,ltask`, `,ltask true|false|del <id>`, `,remindme <teks> <durasi>`
- Save: `,save`, `,load`, `,load <id|judul>`, `,load del <id|judul>`, `,load change <id|judul> <judul-baru>`
- Note/link: `,note`, `,note del <id|judul>`, `,note change <id|judul> <judul-baru>`, `,link`, `,link del <id|nama>`, `,link change <id|nama> <nama-baru>`
- Utility: `,info`, `,status`, `,status bot`, `,health`, `,won`, `,backup`, `,restore`, `,clear`, `,update`, `,restartbot`, `,allow`, `,admin`, `,bot`, `,anticall`, `,changedmsg`, `,statussave`, `,config`, `,log`, `,net`, `,button`
- Session: `,end`, `,cancel`, `,confirm`

## Catatan Fitur

View-once/media:

- Reply media atau view-once lalu ketik `,rs`.
- Bot mengirim media itu kembali ke chat tempat command dijalankan.
- Jika `,rs` dipakai pada sticker, sticker statis dikirim sebagai PNG dan sticker bergerak dikirim sebagai GIF.
- Reply media lalu kirim teks yang berakhir spasi titik, contoh `halo .`, untuk mengirim media ke grup target `IrOBot`.
- Teks sebelum ` .` dipakai sebagai caption baru jika media mendukung caption.

Operasional:

- Owner adalah akun WhatsApp yang sedang login.
- `,allow here true|false` membuka/menutup akses publik di chat/grup tempat command dikirim.
- `,allow all true|false` membuka/menutup akses publik di semua chat/grup.
- Akses publik biasa berlaku untuk `,help`, `,s`, `,smeme`, dan `,rs`.
- `,help` dinamis: publik hanya melihat command publik, admin tambahan melihat command yang boleh dia pakai, owner melihat semuanya. `,help <command|prefix>` menampilkan detail atau kandidat command.
- `,admin list|add|del <nomor|id>` mengelola admin tambahan. Hanya owner/session WhatsApp yang bisa menjalankannya.
- Admin tambahan hanya aktif saat akses publik chat/all terbuka, dan tetap tidak bisa memakai command server/security seperti `,admin`, `,bot`, `,backup`, `,restore`, `,update`, dan `,restartbot`.
- `,bot` mengecek status. `,bot off` mem-pause command, session, scheduler, backup otomatis, changedmsg, statussave, dan anticall; hanya owner bisa `,bot on`.
- `,status bot` menampilkan status fitur bot, destination, scheduler, dan warning jika nama grup duplikat atau destination tidak valid.
- Semua destination grup disimpan sebagai JID + nama saat disimpan. Jika nama grup sama lebih dari satu, bot menolak auto-pilih dan meminta JID.

PDF:

- Ketik `,topdf` atau `,topdf laporan`.
- Ketik `,topdf split` untuk membuat setiap media dalam sesi menjadi PDF terpisah saat `,end`.
- Jika nama kosong, nama PDF default memakai format WIB seperti `23_5_2026_115700_IrOBot.pdf`.
- Batas ukuran opsional bisa ditulis setelah koma, contoh `,topdf laporan,1MB`; `mb` dan `MB` sama-sama dibaca sebagai megabytes.
- Kirim/reply beberapa media atau dokumen.
- Saat media ditambahkan, bot mengedit satu pesan progress berisi item terbaru, total saat ini, daftar file, dan instruksi `,end`/`,cancel`.
- Caption/teks angka dipakai sebagai urutan PDF.
- Jika nomor sudah terisi, bot memberi warning dan media tidak ditambahkan.
- Audio, video, GIF, dan animasi dilewati dengan pesan alasan.
- Jika batas ukuran dipasang, bot mencoba kompres gambar. Jika tetap melebihi batas, PDF tidak dikirim.
- Ketik `,end` untuk membuat PDF.

PDF ke image:

- Reply/kirim dokumen PDF lalu ketik `,toimg`.
- Bot mengirim setiap halaman PDF sebagai image PNG.
- Jika runtime sharp tidak bisa render PDF langsung, fallback butuh Poppler `pdftoppm` atau ImageMagick `magick`.

Anticall:

- `,anticall new|on|off` mengatur pesan dan status anticall.
- `,anticall except list|add|del <nomor|id>` mengelola nomor yang tetap boleh menelepon walaupun anticall aktif.
- Format nomor menerima contoh `08123431212`, `+62 123-1234-1234`, dan `+6212312341234`.

Save/load:

- Judul `,save`, `,note`, dan `,link` wajib unik.
- Judul dengan spasi bisa memakai quote, contoh: `,save "judul panjang"`.

Reminder:

- `,remindme minum 10m`
- Durasi mendukung `10s`, `5m`, `2h`, `1d`, dan `1h30m`.
- Reminder dikirim ke grup target `IrOBot`.

Backup/restore:

- `,backup` membuat zip folder `data/` dan mengirimnya ke destination WhatsApp `dest.backup`.
- Backup otomatis berjalan setiap `00:00` WIB secara default dengan mekanisme yang sama seperti `,backup`.
- Jika zip terlalu besar, bot mengirim part seperti `PART1-2026-05-15-18_12_49.zip`.
- Tujuan backup bisa group atau nomor: `,config set dest.backup <nama-grup|jid|nomor>`.
- `,restore` dimulai dari WhatsApp, lalu kirim file zip/part sebagai dokumen.
- Setelah semua part terkirim, ketik `,end`, lalu `,confirm`; folder `data/` akan ditimpa dari isi zip.
- Backup tidak mencakup `auth/`, `.env`, `logs/`, atau `temp/`.

Konfirmasi:

- Aksi hapus, `,clear`, final `,restore`, `,update`, `,restartbot`, dan perubahan admin wajib dikonfirmasi dengan `,confirm`.
- Ketik `,cancel` untuk membatalkan konfirmasi pending atau sesi aktif.
- Konfirmasi dan prompt session juga menerima reaction `👍`, `❤️`, `✅` untuk lanjut/end/confirm dan `❌`, `👎`, `❎` untuk cancel.
- Reaction hanya diterima dari user yang memicu command, dan kedaluwarsa setelah 1 menit.
- List seperti `,load`, `,note`, `,link`, `,ltask`, `,won`, `,admin list`, dan `,anticall except list` dikirim per item. React `❌`, `👎`, atau `❎` pada item untuk memulai konfirmasi hapus.

Changed message, logs, dan status:

- Default destination: grup/target `logs`, `changedmsg`, dan `saved`. Bisa diganti ke grup atau nomor lewat `,config set dest.logs|dest.changedmsg|dest.saved <target>`.
- `,changedmsg list|allow|del <id|nama-grup|jid>` mengatur grup yang dipantau untuk pesan terhapus/diedit. Direct message dipantau default.
- Pesan dari chat terpantau dimirror ke `logs`; saat pesan dihapus atau diedit, laporan dikirim ke `changedmsg`.
- Index changedmsg hanya menyimpan metadata/text kecil, bukan media bytes. Media diamankan lewat salinan WhatsApp di `logs`.
- `,statussave list|add|del <nomor|id>` menyimpan status WhatsApp dari nomor tertentu ke `saved`.
- `,config` menampilkan key aman yang bisa diubah; `,config get <key>` dan `,config set <key> <value>` untuk membaca/mengubah.

Utility tambahan:

- `,log [baris]` menampilkan log server terbaru, default 30 baris dan maksimal 80 baris.
- `,net` mengecek public IP, DNS, HTTP latency, local IP, dan estimasi download kecil.
- `,button <pesan>` mengirim pesan test dengan satu tombol. Jika tombol ditekan, reply tombol dibaca sebagai command `,<pesan>`.

Update/restart:

- `,restartbot` melakukan graceful exit.
- `,update` menjalankan `git pull origin main`, lalu restart service systemd.
- Jika restart systemd butuh authentication, bot mencoba `sudo -S systemctl` memakai `LINUX_SUDO_PASSWORD` dari `.env`.
- Default service systemd adalah `irobot-wa.service`; ubah di `data/config.json` bagian `update.systemdService`.
- Agar bot benar-benar hidup lagi, jalankan lewat supervisor seperti PM2, systemd, nodemon, atau service manager lain.

## Fitur yang Bergantung Tool Sistem

- Sticker/media dan sebagian konversi: butuh `ffmpeg`.
- Office ke PDF: butuh `libreoffice` atau `soffice`.
- PDF ke image: butuh dukungan PDF di sharp, Poppler `pdftoppm`, atau ImageMagick `magick`.

Bot tetap bisa start tanpa tool tersebut. Command yang membutuhkan tool hilang akan memberi pesan error yang jelas.

## Pindah Device

1. Clone/copy project.
2. Jalankan `npm run setup`.
3. Isi `.env` dan cek `data/config.json`.
4. Jalankan `npm run doctor`.
5. Jalankan `npm start`.
6. Scan QR bila folder `auth/` tidak ikut dipindah.

Jangan upload `auth/`, `.env`, `logs/`, `temp/`, atau file runtime `data/*.json` pribadi ke GitHub.
