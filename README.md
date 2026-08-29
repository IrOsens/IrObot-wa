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

Di Linux/Armbian, setup akan menawarkan pemasangan systemd service agar bot auto-start setelah reboot/crash. Untuk non-interactive:

```bash
npm run setup -- --no-service
npm run setup -- --service
npm run setup -- --user-service
sudo npm run setup -- --system-service
```

## Konfigurasi

`.env`:

```env
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

### Systemd Service

Linux/Armbian:

```bash
npm run service:install
npm run service:status
npm run service:logs
npm run service:start
npm run service:stop
npm run service:restart
npm run service:disable
```

Alias cepat dari folder project:

```bash
npm run bot:on
npm run bot:off
```

System service manual:

```bash
sudo systemctl status irobot-wa --no-pager
sudo journalctl -u irobot-wa -f
sudo systemctl start irobot-wa
sudo systemctl stop irobot-wa
sudo systemctl restart irobot-wa
sudo systemctl disable --now irobot-wa
```

User service:

```bash
systemctl --user status irobot-wa --no-pager
journalctl --user -u irobot-wa -f
systemctl --user start irobot-wa
systemctl --user stop irobot-wa
systemctl --user restart irobot-wa
systemctl --user disable --now irobot-wa
```

`Restart=always` menjaga bot hidup lagi setelah crash. Jika internet mati lalu hidup lagi, reconnect tetap mengandalkan logic Baileys di bot; service hanya memastikan prosesnya menyala.

## Command

- Media: `,s`, `,smeme`, `,resend`, `,qr`, `,topdf`, `,toimg`
- Reminder/task: `,task list|add|loop|repeat|record|pause|stop|resume|del`, `,remindme <teks> <durasi>`
- Save: `,save`, `,save update`, `,load`, `,load <id|judul>`, `,load del <id|judul>`, `,load rename <id|judul> <judul-baru>`
- Note/link: `,note list|add|get|del|rename`, `,link list|add|get|del|rename`
- Utility: `,info`, `,typing`, `,status`, `,status bot`, `,health`, `,wol`, `,backup`, `,restore`, `,clear`, `,update`, `,restartbot`, `,allow`, `,admin`, `,bot`, `,anticall`, `,changedmsg`, `,statussave`, `,config`, `,log`, `,net`, `,button`
- Session: `,end`, `,cancel`, `,confirm`

## Catatan Fitur

View-once/media:

- Reply media atau view-once lalu ketik `,resend`.
- Bot mengirim media itu kembali ke chat tempat command dijalankan.
- Jika `,resend` dipakai pada sticker, sticker statis dikirim sebagai PNG dan sticker bergerak dikirim sebagai GIF.
- Legacy `,rs` tetap didukung.
- Jika owner membalas media view-once dengan pesan biasa, bot otomatis mengirim medianya ke grup target `IrOBot`.
- Teks balasan dipakai sebagai caption baru jika media mendukung caption; balasan berupa command tidak memicu pengiriman otomatis.

Sticker:

- `,s` memakai kualitas maksimum secara default dan membuat canvas 512x512 dengan padding transparan.
- Gunakan `q=1-100` untuk memilih kualitas, contoh `,s q=80` atau `,s Judul,Author q=80`.
- Bot hanya menurunkan kualitas/resolusi lebih lanjut jika diperlukan agar ukuran sticker dapat dikirim WhatsApp.

QR code:

- Langsung: `,qr <pesan>`. Hasil dikirim sebagai reply pada pesan command.
- Sesi: kirim `,qr`, lanjutkan dengan beberapa pesan terpisah, lalu `,end`. Setiap pesan dibuat menjadi QR tersendiri dan hasilnya membalas pesan sumber masing-masing.
- Sesi juga dapat diselesaikan dengan reaction `✅`/`👍`/`❤️`, atau dibatalkan dengan `,cancel` dan reaction `❌`/`👎`/`❎`.
- Style opsional: `style=square`, `style=dot`, atau `style=rounded`.
- Background opsional: `bg=white|black|red|blue|green|yellow|purple|orange` atau hex `bg=#RRGGBB`. Warna modul QR otomatis dibuat hitam/putih dengan kontras terbaik.
- Contoh: `,qr style=dot bg=blue halo dunia` atau mulai sesi dengan `,qr style=rounded bg=#ffcc00`.
- Lampirkan gambar/GIF pada pesan yang memiliki teks/caption untuk menjadikannya ikon tengah QR. GIF memakai frame pertama; media tanpa teks ditolak.

Operasional:

- Owner adalah akun WhatsApp yang sedang login.
- `,typing <nomor|nama-grup|jid>` menyalakan indikator sedang mengetik terus-menerus pada target. Nomor menerima format `08...`, `8...`, `62...`, `+62...`, spasi, dan tanda hubung.
- Beberapa target bisa aktif sekaligus. `,typing` menampilkan target aktif dan `,typing stop` menghentikan semuanya. Target disimpan dan dilanjutkan setelah reconnect/restart sampai dihentikan manual.
- `,allow here on|off` membuka/menutup akses publik di chat/grup tempat command dikirim.
- `,allow all on|off` membuka/menutup akses publik di semua chat/grup.
- Legacy `true|false` tetap didukung untuk `,allow`.
- Akses publik biasa berlaku untuk `,help`, `,s`, `,smeme`, `,resend`, `,qr`, dan legacy `,rs`.
- `,help` dinamis: publik hanya melihat command publik, admin tambahan melihat command yang boleh dia pakai, owner melihat semuanya. `,help <command|prefix>` menampilkan detail atau kandidat command.
- `,admin list|add|del <nomor|id>` mengelola admin tambahan. Hanya owner/session WhatsApp yang bisa menjalankannya.
- Admin tambahan hanya aktif saat akses publik chat/all terbuka, dan tetap tidak bisa memakai command server/security seperti `,admin`, `,bot`, `,backup`, `,restore`, `,update`, dan `,restartbot`.
- `,bot` mengecek status. `,bot off` mem-pause command, session, scheduler, backup otomatis, changedmsg, statussave, dan anticall; hanya owner bisa `,bot on`.
- `,status bot` menampilkan status fitur bot, destination, scheduler, dan warning jika nama grup duplikat atau destination tidak valid.
- Semua destination grup disimpan sebagai JID + nama saat disimpan. Jika nama grup sama lebih dari satu, bot menolak auto-pilih dan meminta JID.

PDF:

- Ketik `,topdf` atau `,topdf laporan`.
- Ketik `,topdf split laporan` untuk membuat setiap media dalam sesi menjadi PDF terpisah saat `,end`.
- Jika nama kosong, nama PDF default memakai format WIB seperti `23_5_2026_115700_IrOBot.pdf`.
- Batas ukuran opsional: `,topdf laporan max 1MB` atau `,topdf split scan max 1MB`.
- Legacy `,topdf laporan,1MB` tetap didukung.
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
- Update isi dengan `,save update <id|"judul lama"> ["judul baru"]`, kirim isi pengganti, lalu `,end`. Hasil update mendapat ID baru dan muncul paling bawah.
- Ganti nama tanpa mengubah isi/urutan dengan `,load rename <id|"judul lama"> "judul baru"`; legacy `,load change` tetap didukung.
- ID save yang masih ada tidak berubah setelah save lain dihapus; angka yang sudah dipakai tidak digunakan ulang.
- Note: `,note add <judul> <teks>`, `,note get <id|judul>`, `,note del <id|judul>`, `,note rename <id|judul> <judul-baru>`.
- Link: `,link add <nama> <https://link>`, `,link get <id|nama>`, `,link del <id|nama>`, `,link rename <id|nama> <nama-baru>`.

Reminder:

- `,remindme minum 10m`
- Durasi mendukung `10s`, `5m`, `2h`, `1d`, dan `1h30m`.
- Reminder dikirim ke grup target `IrOBot`.
- Task: `,task add "backup server" at 23:00`, `,task loop "cek koneksi" at 08:00`, `,task repeat 3 "ingatkan minum" at 21:00`, `,task record 08123431212 at 21:00`, `,task record Tim Produksi at 21:00`, `,task record Grup TA at 21:00`, `,task record loop 08123431212 at 08:00`, `,task pause 2`/`,task stop 2`, `,task resume 2`, `,task del 2`.
- `,task record` membuka sesi rekam untuk nomor, nama kontak, atau nama grup tujuan (tanpa tanda petik; nama yang sama/ambigu akan ditolak): kirim teks, gambar, video, dokumen, audio, sticker, lokasi, kontak, poll, atau event; ketik `,end` untuk menjadwalkan. Batalkan dengan `,cancel` atau reaction ❌/👎/❎ pada prompt sesi.
- Legacy `,ltask`, `,ltask true|false|del <id>` tetap didukung.

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
- List seperti `,load`, `,note`, `,link`, `,task list`, `,wol`, `,admin list`, dan `,anticall except list` dikirim per item. React `❌`, `👎`, atau `❎` pada item untuk memulai konfirmasi hapus.
- Legacy `,ltask` dan `,won` tetap didukung.

Changed message, logs, dan status:

- Default destination: grup/target `logs`, `changedmsg`, dan `saved`. Bisa diganti ke grup atau nomor lewat `,config set dest.logs|dest.changedmsg|dest.saved <target>`.
- `,changedmsg list|allow|del <id|nama-grup|jid>` mengatur grup yang dipantau untuk pesan terhapus/diedit. Direct message dipantau default.
- Pesan dari chat terpantau dimirror ke `logs`; saat pesan dihapus atau diedit, laporan dikirim ke `changedmsg`.
- Index changedmsg hanya menyimpan metadata/text kecil, bukan media bytes. Media diamankan lewat salinan WhatsApp di `logs`.
- `,statussave list|add|del <nomor|id>` menyimpan status WhatsApp dari nomor tertentu ke `saved`.
- `,config` menampilkan key aman yang bisa diubah; `,config get <key>` dan `,config set <key> <value>` untuk membaca/mengubah.

Utility tambahan:

- `,wol list`, `,wol add <mac>`, `,wol wake <id|mac>`, dan `,wol del <id|mac>` untuk Wake-on-LAN. Legacy `,won` tetap didukung.
- `,log [baris]` menampilkan log server terbaru, default 30 baris dan maksimal 80 baris.
- `,net` mengecek public IP, DNS, HTTP latency, local IP, dan estimasi download kecil.
- `,button <pesan>` mengirim pesan test dengan satu tombol. Jika tombol ditekan, reply tombol dibaca sebagai command `,<pesan>`.

Update/restart:

- `,restartbot` melakukan graceful exit.
- `,update` menjalankan `git pull origin main`, lalu restart service systemd.
- Jika restart systemd butuh authentication, bot mencoba `sudo -S systemctl` memakai `LINUX_SUDO_PASSWORD` dari `.env`.
- Default service systemd adalah `irobot-wa.service`; ubah di `data/config.json` bagian `update.systemdService`.
- Agar bot benar-benar hidup lagi setelah reboot/crash, pakai `npm run service:install` di Linux/Armbian.

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
