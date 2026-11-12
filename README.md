# IrO WhatsApp Bot

Bot WhatsApp pribadi berbasis Baileys. Login memakai QR di terminal, command memakai prefix koma, dan akun yang sedang login menjadi owner/superuser bot.

## Ringkas

- Cocok dipindah ke Linux atau Windows lain.
- Data runtime berada di `data/`, credential di `.env` dan `auth/`.
- Tool sistem opsional dipakai untuk fitur media dan PDF.
- Backup `data/` default dikirim ke destination WhatsApp `backup`; opsi lokal tersedia melalui `,setup backup`.

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

- Media: `,s`, `,stext`, `,smeme`, `,resend`, `,qr`, `,topdf`, `,toimg`, `,tovideo`, `,stimpa`
- Reminder/task: `,task list|add|loop|repeat|record|pause|stop|resume|del`, `,remindme <teks> <durasi>`
- Save: `,save`, `,save update`, `,load`, `,load <id|judul>`, `,load del <id|judul>`, `,load rename <id|judul> <judul-baru>`
- Note/link: `,note list|add|get|del|rename`, `,link list|add|get|del|rename`
- Utility: `,info`, `,typing`, `,status`, `,status bot`, `,health`, `,wol`, `,backup`, `,restore`, `,clear`, `,update`, `,pull`, `,restartbot`, `,allow`, `,admin`, `,pause`, `,resume`, `,anticall`, `,changedmsg`, `,statussave`, `,config`, `,log`, `,net`, `,button`
- Worker: `,jadibot`, `,jadibot kode`, `,worker list|info|session|exit|service|default`, `,cinta`
- Session: `,end`, `,cancel`, `,confirm`

## Catatan Fitur

View-once/media:

- Reply media atau view-once lalu ketik `,resend`.
- Bot mengirim media itu kembali ke chat tempat command dijalankan.
- Jika `,resend` dipakai pada sticker, sticker statis dikirim sebagai PNG dan sticker bergerak dikirim sebagai GIF.
- Legacy `,rs` tetap didukung.
- Jika owner membalas media view-once dengan pesan biasa, bot otomatis mengirim medianya ke grup target `IrOBot`. Owner juga bisa memberi reaksi emoji apa pun pada pesan view-once yang sama untuk meneruskannya (sekali per pesan). Reaksi pada pesan biasa tidak diteruskan.
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
- `,tovideo` juga tersedia pada chat yang diberi akses publik.
- `,help` dinamis: publik hanya melihat command publik, admin tambahan melihat command yang boleh dia pakai, owner melihat semuanya. `,help <command|prefix>` menampilkan detail atau kandidat command.
- `,admin list|add|del <nomor|id>` mengelola admin tambahan. Hanya owner/session WhatsApp yang bisa menjalankannya.
- Admin tambahan hanya aktif saat akses publik chat/all terbuka, dan tetap tidak bisa memakai command server/security seperti `,admin`, `,pause`, `,worker`, `,backup`, `,restore`, `,update`, dan `,restartbot`.
- `,pause` mem-pause command, session, scheduler, backup otomatis, changedmsg, statussave, dan anticall akun utama; hanya owner bisa `,resume`. Worker tetap berjalan saat akun utama di-pause.
- `,status bot` menampilkan status fitur bot, destination, scheduler, dan warning jika nama grup duplikat atau destination tidak valid.
- Semua destination grup disimpan sebagai JID + nama saat disimpan. Jika nama grup sama lebih dari satu, bot menolak auto-pilih dan meminta JID.

PDF:

- Ketik `,topdf` atau `,topdf laporan`.
- Ketik `,topdf split laporan` untuk membuat setiap media dalam sesi menjadi PDF terpisah saat `,end`.
- Jika nama kosong, nama PDF default memakai format WIB seperti `23_5_2026_115700_IrOBot.pdf`.
- Format utama: `,topdf --name "laporan" --max-size 1MB` untuk batas maksimum ukuran file.
- Ukuran tepat: `,topdf --name "laporan" --target-size 2MB`; file yang terlalu besar dikompres, yang lebih kecil ditambah padding PDF valid. Padding tidak meningkatkan kualitas.
- Split: `,topdf --split --name "scan" --max-size 500KB`; batas/target berlaku per PDF keluaran.
- `--max-size` dan `--target-size` tidak boleh digabung. Target tepat maksimal 100MB. Satuan biner: 1KB = 1024 byte, 1MB = 1048576 byte; pecahan dibulatkan ke bawah, minimal 1 byte.
- Nama berspasi memakai kutip dengan `--name`, termasuk nama seperti `"split max laporan"`. Opsi boleh diurutkan bebas; opsi duplikat/tidak dikenal ditolak. Jangan campur format flag dan format lama.
- Format lama `,topdf laporan max 1MB` dan `,topdf split scan max 1MB` tetap didukung.
- Legacy `,topdf laporan,1MB` tetap didukung.
- Kirim/reply beberapa media atau dokumen.
- Saat media ditambahkan, bot mengedit satu pesan progress berisi item terbaru, total saat ini, daftar file, dan instruksi `,end`/`,cancel`.
- Caption/teks angka dipakai sebagai urutan PDF.
- Jika nomor sudah terisi, bot memberi warning dan media tidak ditambahkan.
- Audio, video, GIF, dan animasi dilewati dengan pesan alasan.
- Pengaturan ukuran mendukung gambar, PDF yang sudah ada, dan hasil konversi Office. Jika perlu, seluruh halaman PDF dirasterisasi dengan Sharp/Poppler pdftoppm/ImageMagick magick; teks tidak lagi bisa diseleksi dan kualitas bisa turun. Jumlah, urutan, serta dimensi halaman dipertahankan.
- Jika renderer tidak tersedia, PDF tidak dapat dibaca, atau ukuran tidak tercapai, bot memberi error dan tidak mengirim hasil yang melanggar batas/target. Dimensi kertas tidak diubah oleh parameter ukuran file.
- Ketik `,end` untuk membuat PDF.

PDF ke image:

- Reply/kirim dokumen PDF lalu ketik `,toimg`.
- Bot mengirim setiap halaman PDF sebagai image PNG.

Video dari gambar atau video:

- Kirim gambar/video dengan caption `,tovideo`, atau reply gambar/video/stiker dengan command yang sama. Jika stiker dikirim lebih dulu, lanjutkan dengan gambar/video template yang sudah menampilkan stiker pada posisi tujuan.
- Tanpa `duration`, gambar menjadi 5 detik dan video mengikuti durasi aslinya (dibagi faktor kecepatan bila dipakai). Gunakan `duration=3s`, `duration=2m`, atau gabungan satuan untuk menetapkan durasi hasil, termasuk saat sesi berlangsung.
- `speed=2` mempercepat video dan audio sumber 2×, `slow=2` memperlambat 2×; rentang `speed=0.25-4` atau `slow=1-4`. Contoh: reply video dengan `,tovideo speed=2`, lalu `,end`. Gambar statis tetap statis; musik tambahan tidak diubah temponya. `duration=...` tetap menentukan durasi keluaran (video dipotong/diulang jika perlu).
- Default MP4 dan `q=100`. Pakai `format=gif` untuk tampilan GIF WhatsApp tanpa audio, atau `q=80` untuk kualitas lebih rendah.
- Bot membuka sesi. Kirim beberapa stiker WhatsApp yang sudah terlihat pada gambar/frame awal, audio musik, atau instruksi teks `duration=2m`, `speed=2`, `slow=2`, `sync`, `mute`, `unmute`, `vvol=50%`, `mvol=50%`, dan `format=gif`.
- `sync` mengikuti durasi musik. Video dan audio yang lebih pendek diulang, sedangkan yang lebih panjang dipotong. Musik dan suara video dicampur kecuali `mute` dipakai. Musik pada mode GIF diabaikan.
- Selesaikan dengan `,end` atau reaction ✅/👍/❤️; batalkan dengan `,cancel` atau ❌/👎/❎. Setelah konfirmasi bot mengirim satu pesan progres yang diedit sampai hasil terkirim.
- Posisi, ukuran, dan rotasi stiker dicocokkan otomatis dari beberapa frame animasi, termasuk jika stiker memiliki ruang transparan. Area latar yang tertutup stiker diperkirakan. Jika tidak cocok, hasil tidak dikirim dan sesi bisa diperbaiki.
- Jika runtime sharp tidak bisa render PDF langsung, fallback butuh Poppler `pdftoppm` atau ImageMagick `magick`.

Stiker bergerak dengan gambar edit:

- Reply stiker bergerak dengan `,stimpa`. Bot mengirim frame pertama sebagai kanvas gambar 512×512.
- Edit kanvas itu di WhatsApp dengan teks, coretan, atau gambar; kirim satu atau beberapa gambar hasil edit tanpa memotong gambar. Bot hanya menerima gambar yang cocok dengan kanvas sesi dan menumpuk edit dari semuanya. Gambar yang tidak cocok dilewati.
- Ketik `,end` atau beri reaksi ✅/👍/❤️ pada prompt sesi. Bot menaruh gabungan perubahan pada setiap frame asli, lalu mengirim stiker WebP bergerak. `,cancel` atau ❌/👎/❎ membatalkan. Pemilik sesi dan nomor admin/host dapat mengakhiri/membatalkan sesi; pengguna lain tidak bisa.
- Lapisan edit tetap pada posisi yang sama sementara animasi asli berjalan. Menghapus bagian asli atau menggerakkan lapisan edit secara terpisah belum didukung.

Anticall:

- `,anticall new|on|off` mengatur pesan dan status anticall.
- `,anticall except list|add|del <nomor|id>` mengelola nomor yang tetap boleh menelepon walaupun anticall aktif.
- Format nomor menerima contoh `08123431212`, `+62 123-1234-1234`, dan `+6212312341234`.

Save/load:

- Judul `,save`, `,note`, dan `,link` wajib unik.
- Judul dengan spasi bisa memakai quote, contoh: `,save "judul panjang"`.
- Tambahkan isi dengan `,save update <id|"judul lama"> ["judul baru"]`. Bot mengirim ulang dua item terakhir sebagai pratinjau (atau satu jika hanya ada satu), lalu mulai sesi: kirim konten tambahan dan akhiri dengan `,end`. Isi lama tetap ada, konten baru diletakkan di bawahnya, dan ID tidak berubah. `,cancel` membatalkan tanpa mengubah save.
- Ganti nama tanpa mengubah isi/urutan dengan `,load rename <id|"judul lama"> "judul baru"`; legacy `,load change` tetap didukung.
- ID save yang masih ada tidak berubah setelah save lain dihapus; angka yang sudah dipakai tidak digunakan ulang.
- Note: `,note add <judul> <teks>`, `,note get <id|judul>`, `,note del <id|judul>`, `,note rename <id|judul> <judul-baru>`.
- Link: `,link add <nama> <https://link>`, `,link get <id|nama>`, `,link del <id|nama>`, `,link rename <id|nama> <nama-baru>`.

Reminder:

- `,remindme minum 10m`
- Durasi mendukung `10s`, `5m`, `2h`, `1d`, dan `1h30m`.
- Reminder dikirim ke grup target `IrOBot`. `,remindme <durasi>` membuka listening untuk merekam isi reminder.
- Task: `,task add "backup server" at 23:00`, `,task loop "cek koneksi" at 08:00`, `,task repeat 3 "ingatkan minum" at 21:00`, `,task record 08123431212 at 21:00`, `,task record Tim Produksi at 21:00`, `,task record Grup TA at 21:00`, `,task record loop 08123431212 at 08:00`, `,task pause 2`/`,task stop 2`, `,task resume 2`, `,task del 2`.
- `,task record` membuka sesi rekam untuk nomor, nama kontak, atau nama grup tujuan (tanpa tanda petik; nama yang sama/ambigu akan ditolak): kirim teks, gambar, video, dokumen, audio, sticker, lokasi, kontak, poll, atau event; ketik `,end` untuk menjadwalkan. Batalkan dengan `,cancel` atau reaction ❌/👎/❎ pada prompt sesi.
- Legacy `,ltask`, `,ltask true|false|del <id>` tetap didukung.

Backup/restore:

- `,backup` membuat zip folder `data/` dan menyimpannya ke tujuan backup aktif (default WhatsApp `dest.backup`).
- Backup otomatis berjalan setiap `00:00` WIB secara default dengan mekanisme yang sama seperti `,backup`.
- Jika zip terlalu besar, bot mengirim part seperti `PART1-2026-05-15-18_12_49.zip`.
- Tujuan backup bisa group atau nomor: `,config set dest.backup <nama-grup|jid|nomor>`.
- `,restore` dimulai dari WhatsApp, lalu kirim file zip/part sebagai dokumen.
- Setelah semua part terkirim, ketik `,end`, lalu `,confirm`; folder `data/` akan ditimpa dari isi zip.
- `,restore save` memulihkan hanya koleksi `,save` dari ZIP/part backup lama. Setelah `,end`, pilih semua save atau pilih beberapa lewat angka (1–10 per halaman, 11/12 pindah halaman, `0` kembali). Dalam daftar, ketik `,end` setelah menandai pilihan.
- Pilih `timpa` untuk mengganti seluruh koleksi save sekarang dengan pilihan backup, atau `gabung` untuk menambahkan pilihan sebagai save baru. Judul yang sama dalam mode gabung diberi akhiran `(backup)`; ID baru dialokasikan. Keduanya memerlukan `,confirm` dan tidak mengubah data fitur lain.
- Backup tidak mencakup `auth/`, `.env`, `logs/`, atau `temp/`.

Konfirmasi:

- Aksi hapus, `,clear`, final `,restore`, `,update`, `,restartbot`, dan perubahan admin wajib dikonfirmasi dengan `,confirm`.
- Ketik `,cancel` untuk membatalkan konfirmasi pending atau sesi aktif.
- Konfirmasi dan prompt session juga menerima reaction `👍`, `❤️`, `✅` untuk lanjut/end/confirm dan `❌`, `👎`, `❎` untuk cancel.
- Reaction hanya diterima dari user yang memicu command. Konfirmasi/item daftar kedaluwarsa setelah 1 menit; prompt listening mengikuti masa aktif sesi.
- List seperti `,load`, `,note`, `,link`, `,task list`, `,wol`, `,admin list`, dan `,anticall except list` dikirim per item. React `❌`, `👎`, atau `❎` pada item untuk memulai konfirmasi hapus.
- Legacy `,ltask` dan `,won` tetap didukung.

Changed message, logs, dan status:

- Default destination: grup/target `logs`, `changedmsg`, dan `saved`. Bisa diganti ke grup atau nomor lewat `,config set dest.logs|dest.changedmsg|dest.saved <target>`.
- `,changedmsg list|allow|del <id|nama-grup|jid>` mengatur grup yang dipantau untuk pesan terhapus/diedit. Direct message dipantau default.
- Pesan dari chat terpantau dimirror ke `logs`; saat pesan dihapus atau diedit, laporan dikirim ke `changedmsg`.
- Index changedmsg menyimpan metadata/text dan referensi arsip. Media diamankan di tujuan `logs` aktif, berupa salinan WhatsApp atau file lokal.
- `,statussave list|add|del <nomor|id>` mengatur nomor auto-save status. Tujuan aktif dipilih melalui `,setup statussave`; default instalasi adalah grup `saved`.
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

## Multi Login (Worker)

Akun yang login lewat terminal tetap menjadi admin utama (owner). Akun lain bisa ikut terhubung ke server ini sebagai **worker**.

Mendaftar jadi worker:

1. User mengetik `,jadibot` (QR) atau `,jadibot kode` (kode tautan) di chat mana pun dengan akun utama. Command ini terbuka untuk semua user.
2. Owner menerima notifikasi di chat pribadinya. Setujui dengan reply `accept`/`yes`/`ya`, atau react `✅`/`👍`/`❤️` pada notifikasi atau pada pesan `,jadibot` user. Tolak dengan reply `no`/`tolak` atau react `❌`/`👎`/`❎`. Permintaan kedaluwarsa setelah 10 menit.
3. Setelah disetujui, QR dikirim ke chat yang sama (chat pribadi) atau ke chat pribadi user (jika `,jadibot` dikirim di grup). QR diperbarui otomatis dan berlaku 60 detik. Jika kedaluwarsa, user bisa `,jadibot` lagi tanpa persetujuan ulang selama 10 menit.
   QR harus discan dari HP/perangkat lain. Pesan terakhir setelah QR menjelaskan alternatif: ketik `,jadibot kode` (bisa langsung saat QR masih aktif) lalu salin kode yang dikirim dan tempel di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon.
4. Satu nomor hanya bisa menjadi satu worker. Worker tidak bisa dihapus dari bot; berhenti hanya dengan logout perangkat tertaut di WhatsApp.

Command owner:

- `,worker` atau `,worker list`: daftar worker dengan status dan link `wa.me`.
- `,worker info <id|nomor>`: detail worker beserta foto profil (disimpan saat pertama login).
- `,worker session <id|nomor>`: masuk sesi worker. Setelah itu command yang diketik admin di chat mana pun (pribadi atau grup) dijalankan dengan konteks worker (service, command, dan data worker). Balasan tetap dikirim dari akun utama dan diberi tanda status di baris paling atas, misalnya `Admin sebagai Worker #2 - +62811...`. Command akun utama lain (`,pause`, `,backup`, dll.) tidak tersedia selama sesi. Keluar dengan `,worker exit` setelah sesi rekam/PDF/dll. yang sedang berjalan selesai (`,end`) atau dibatalkan (`,cancel`).
- `,worker service list`: daftar service yang tersedia.
- `,worker service <id|nomor> <nama|off>`: pasang atau lepas service.
- `,worker default <id|nomor> on|off`: izinkan command default untuk worker yang memakai service.

Command worker (diketik dari akun worker sendiri, misalnya di chat "Pesan ke diri sendiri"):

- Tanpa service: `,help`, `,status`, `,s`, `,stext`, `,smeme`, `,resend`, `,qr`, `,topdf`, `,tovideo`, `,stimpa`, `,toimg`, `,note`, `,link`, `,end`, `,cancel`, `,confirm`.
- Dengan service: hanya `,help`, `,status`, command service, dan kontrol sesi, kecuali owner mengaktifkan `,worker default`.
- Pesan dari orang lain ke nomor worker tidak menjalankan command; hanya service (misalnya `cinta`) yang membalas.

Service `cinta`:

- Membalas pesan pribadi yang isinya persis `Aku mau pesan kak` atau `Aku mau pesan kak!` (boleh huruf kecil semua atau kapital semua). Pesan dengan karakter lain tidak memicu balasan.
- Balasan berupa pesan otomatis hasil rekaman `,cinta`. Selama belum ada rekaman, balasan memakai teks Tako-Wae bawaan tanpa gambar.
- `,cinta` membuka sesi rekam seperti `,save` atau `,anticall new`: kirim teks, gambar, atau media lain, lalu `,end` atau reaksi `✅`/`👍`/`❤️` untuk menyimpannya sebagai pesan otomatis. `,cancel` atau reaksi `❌`/`👎`/`❎` membatalkan. Rekaman baru menggantikan yang lama. Selama belum ada rekaman, balasan memakai teks Tako-Wae bawaan.
- `,cinta trigger <teks>` mengganti trigger (satu trigger per baris), `,cinta emoji <emoji|->` mengganti emoji reaksi, `,cinta info` melihat pengaturan, `,cinta test` mencoba balasan, `,cinta reset` mengembalikan ke bawaan.
- Emoji pemicu: jika worker memberi reaksi emoji pemicu (default `🥢`) ke pesan mana pun di chat pribadi, baik pesan sendiri maupun pesan orang lain, pesan otomatis dikirim ke chat itu. Atur dengan `,cinta emojitrigger <emoji,emoji>` (pisahkan dengan koma) atau `,cinta emojitrigger -` untuk mematikan. `,cinta emoji` tetap dipakai untuk emoji reaksi yang diberikan bot pada pesan trigger teks. Reaksi di grup diabaikan.
- `,cinta log` menampilkan jumlah pemakaian trigger (lewat teks atau reaksi), jumlah yang dibalas atau ditahan batas anti-banned, daftar nomor beserta jumlahnya, dan 5 pemakaian terbaru. Data disimpan di `workers/<id>/data/cinta-log.json`.
- Media rekaman disimpan di `workers/<id>/data/cinta/`.
- Command `,cinta` hanya muncul dan bisa dipakai pada worker yang memakai service cinta.

Pengaman anti-banned (khusus worker):

- Balasan service hanya ke chat pribadi, bukan grup/status, dan hanya untuk pesan yang masuk dalam 5 menit terakhir.
- Batas ini juga berlaku untuk balasan yang dipicu reaksi emoji worker. Satu nomor maksimal 3 balasan `cinta` yang sama per jam, dan satu worker maksimal 40 balasan service per jam; setelah batas tercapai tidak ada balasan sampai jamnya bergeser.
- Command yang sama dari pengirim yang sama maksimal 2 kali per menit.
- Balasan didahului tanda dibaca dan indikator mengetik dengan jeda acak (3-8 detik untuk service, 1-2,5 detik untuk command).
- Batas di atas disimpan di memori dan kembali kosong setelah bot restart.

Struktur folder:

```
auth/                 sesi WhatsApp akun utama (tidak berubah)
data/workers.json     daftar worker
workers/<id>/auth/    sesi WhatsApp worker
workers/<id>/data/    note, link, dan konfigurasi service worker
workers/<id>/profile.jpg
workers/archive/<id>/ folder worker yang sudah logout; dipakai lagi jika nomor yang sama login ulang
workers/pending/      sesi QR sementara, dibersihkan saat startup
```

Folder `workers/` tidak ikut `,backup` (backup hanya mencakup `data/`).

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

## Setup tujuan grup / server

`,setup` menampilkan tujuan aktif. Owner dapat memilih **satu tujuan per fitur**:

```text
,setup root /home/iro/hdd35/services/Irobot-wa
,setup statussave local
,setup statussave group saved
,setup backup local /mnt/backup/irobot
,setup logs local
,setup changedmsg local
,setup errors group <JID-grup-errormsg>
```

Pilihan lokal tersedia untuk `statussave`, `backup`, `logs`, dan `changedmsg`. Tanpa path, folder diturunkan dari root + nama fitur. Instalasi baru dan konfigurasi lama tetap memakai grup sampai tujuan lokal dipilih. `dest.saved` tetap menjadi alias tujuan grup statussave; mengubahnya lewat `,config set` juga mengaktifkan mode grup. Mode lokal tidak otomatis kembali ke grup saat gagal. Arsip lama tidak dipindah/dihapus ketika tujuan diganti.

Setup terminal menanyakan root lokal secara opsional. Untuk non-interaktif gunakan `npm run setup -- --storage-root=/path/server`. Folder dibuat dan akses tulis diperiksa sebelum tujuan baru disimpan. Tujuan backup lokal harus di luar `data/` supaya backup tidak memasukkan arsipnya sendiri.

Untuk server yang menjalankan bot sebagai root, aktivasi status lokal dan restart service dapat dilakukan dari direktori proyek:

```bash
sudo /home/iro/.local/bin/node scripts/activate-storage.mjs /home/iro/hdd35/services/Irobot-wa
```

Perintah ini membuat backup konfigurasi, membuat folder `statussave`, mengaktifkan mode lokal statussave, dan restart service yang dikonfigurasi. Tujuan fitur lain dipertahankan.

Arsip status: `<path>/<nama-kontak-atau-nomor>/YYYY-MM-DD/`. Tanggal dan nama waktu menggunakan WIB. Nama kontak tersimpan diprioritaskan, nama sama diberi nomor pembeda, dan folder kontak tidak berubah ketika kontak berganti nama. Teks disimpan sebagai TXT dan metadata sebagai JSON; media disimpan dengan format aslinya. Logs lokal memakai struktur chat/tanggal; laporan changedmsg menyertakan referensi arsip sumber. Backup lokal menghasilkan ZIP atau part ZIP seperti mode grup.

## Statussave: otomatis simpan, tampilkan lewat WhatsApp

Alur utama: **tambahkan nomor sekali → status baru otomatis tersimpan → lihat isinya melalui `list <nomor>`**.

```text
,statussave
,statussave add 08123456789
,statussave list
,statussave list 08123456789
,statussave show 08123456789
,statussave on
,statussave off
,statussave setup
```

- `,statussave` menampilkan ringkasan auto-save, tujuan, dan cara penggunaan. `list` tanpa nomor menampilkan nomor yang dipantau; `list <nomor>` / `show <nomor>` mengirim **seluruh isi status aktif** kontak tersebut ke chat command.
- `add` cukup sekali. Nomor yang sudah terdaftar mendapat konfirmasi bahwa pemantauan sudah ada. Status aktif yang sudah diterima dan status baru berikutnya disimpan otomatis selama fitur aktif; tidak perlu `dump` manual.
- `off` menghentikan arsip otomatis, sementara cache dan fungsi melihat status tetap tersedia selama bot aktif. `on` memproses kembali status aktif dari watchlist yang belum tersimpan. Tujuan arsip tetap memakai konfigurasi grup/lokal yang dipilih.
- Status ditampilkan dari paling lama ke terbaru. Gambar/video menyertakan caption asli; teks dikirim sebagai teks, dan caption audio/tipe lain dikirim sebagai pesan pendamping jika tersedia.
- Menampilkan status tidak mengubah tujuan arsip atau penanda sudah tersimpan. Kamu bisa meminta tampilan berulang kali. Media lokal yang cocok dipakai kembali, atau diunduh jika belum tersedia. Status lama/kedaluwarsa tidak ikut ditampilkan.
- Jika satu status gagal, bot melanjutkan status lainnya dan menampilkan jumlah berhasil/gagal. Error teknis tetap menuju grup error.
- Auto-save mencocokkan nomor dan identitas LID/PN Baileys. Metadata aktif disimpan di `data/status-inbox.json`, bertahan setelah restart, dan dibersihkan setelah status kedaluwarsa/terhapus. Arsip permanen tidak ikut dihapus.
- Bot hanya dapat menampilkan status yang diterimanya. Status terlihat di ponsel belum tentu sudah diterima sesi Baileys.

Command lanjutan tetap tersedia:

```text
,statussave active [kontak] [page=2]
,statussave dump <id-status>
,statussave dump all <kontak>
,statussave del <nomor|id>
```

`active` adalah daftar metadata, maksimal 10 status per halaman. `dump` menyimpan ke tujuan arsip aktif dan melewati status yang sudah tersimpan di tujuan itu. Reply status lalu `,statussave dump` juga didukung bila payload tersedia; jika waktu publikasinya tidak tersedia, arsip mencatat waktu penerimaan. ID status berbeda dari ID watchlist. `fetchStatus` bukan API untuk mengambil koleksi story WhatsApp.

## Listening dan pesan berulang

Save/update, anticall, task record, dan reminder listening mendukung teks, gambar, video, dokumen, stiker, audio, **voice note asli**, lokasi native, kontak, poll, dan event yang didukung Baileys. Live location direkam sebagai posisi yang diterima, bukan pelacakan lanjutan.

- Satu prompt progres diperbarui selama rekaman. Akhiri dengan `,end` atau reaksi ✅/👍/❤️ pada prompt; batalkan dengan `,cancel` atau ❌/👎/❎.
- Hanya pembuat sesi yang bisa mengisi/mengendalikan sesi. Reaksi pada prompt berlaku selama sesi; sesi dibatalkan setelah 30 menit tanpa aktivitas.
- Teks yang diawali command selain `,end`/`,cancel` dianggap isi saat listening rekaman. Pesan bot dan reaksi tidak ikut direkam.
- Penggantian save/anticall mempertahankan isi sebelumnya sampai penyimpanan baru berhasil.

```text
,task record Grup Kerja every 30m count 3
,task record 08123456789 every 2h forever
,task record Grup Kerja every 1h count 5 at 08:00 12/09/2026
,remindme 10m
```

Kirim isi setelah command, lalu `,end`. Tanpa `at`, pengiriman pertama dilakukan setelah interval pertama dari `,end`. `count 3` berarti seluruh rekaman dikirim tiga kali; `forever` berulang sampai dipause/dihapus. Jam/tanggal memakai WIB. `,remindme <durasi>` membuka rekaman satu kali ke tujuan reminder lama; bentuk `,remindme <teks> <durasi>` tetap didukung.

`,task pause|resume|del <id>` tetap tersedia. Jadwal dan progres pengiriman tersimpan; interval yang terlewat tidak dikirim sekaligus setelah restart. Kegagalan atau hasil pengiriman ambigu mem-pause task tanpa mengurangi jumlah kiriman. Periksa penerima sebelum `resume`: item yang belum terkonfirmasi mungkin sebenarnya sudah sampai; resume akan mencoba item tersebut kembali. ID task stabil setelah penghapusan.

## Reaksi hapus dan error teknis

Reaksi ❌/👎/❎ **dari owner pada pesan akun sendiri** meminta hapus untuk semua orang. Prompt sesi, konfirmasi, dan item daftar tetap menjalankan fungsi reaksinya; prompt kedaluwarsa yang dikenali tidak berubah menjadi target hapus otomatis. Reaksi orang lain tidak memicu fitur ini. WhatsApp tetap menentukan apakah pesan dapat dicabut.

Kesalahan format/input tetap dijelaskan di chat command. Error teknis media, jaringan, server, filesystem, scheduler, dan kegagalan revoke dicatat ke log serta antrean `data/error-outbox.json`, lalu dikirim ke grup `errormsg` dalam community `dev`. Bot memilih otomatis hanya jika hubungan community cocok dan hasilnya tunggal; jika belum bisa ditentukan, owner menerima menu setup. Tujuan dapat disimpan eksplisit dengan `,setup errors group <jid>`.

Laporan menyertakan ID kejadian, waktu, sumber, dan detail diagnostik dengan rahasia disamarkan. Error identik yang masih mengantre digabung. Saat offline/tujuan belum tersedia, antrean tetap disimpan; error pengiriman laporan tidak membuat loop. Log harian tetap menjadi catatan penuh, sementara antrean notifikasi dibatasi 500 jenis error terbaru.

## Help dan stiker teks

`,help` menampilkan ringkasan kategori; `,help Media` menampilkan deskripsi singkat; `,help statussave` atau `,help task` menampilkan format lengkap. Command tetap disaring berdasarkan akses pengguna.

```text
,stext Halo dunia
,stext align=center Selamat pagi
,stext align=kiri Teks rata kiri
,stext align=right Teks rata kanan
,stext align=justify Teks rata kiri-kanan
```

Hasilnya stiker WebP 512×512, teks hitam Arial, panel putih bersudut membulat dengan tepi luar transparan 16 px dan jarak teks 36 px dari panel. Tampilan low quality memakai teks yang sedikit buram dan kompresi WebP; ukuran canvas tetap 512×512. Ukuran font otomatis mengikuti isi; setiap kata harus muat utuh dalam satu baris. Perpindahan baris hanya antarkata atau pada baris baru yang diketik. Contoh `anjay` tidak dipecah menjadi `anj` dan `ay`; font diperkecil jika perlu. Paragraf/baris baru dipertahankan. Default rata kiri dengan jarak huruf normal, tanpa direnggangkan untuk memenuhi lebar baris. Justify tetap tersedia jika dipilih melalui align=justify. Alias alignment: `kiri`, `kanan`, `tengah`, `kiri-kanan`. Teks yang tidak muat pada ukuran minimum 8 px harus dipendekkan, tanpa pemotongan diam-diam.

Pasang Arial: `npm run setup:font` (memerlukan `cabextract` dan `fc-scan` pada Linux). Installer memakai arsip Microsoft Core Fonts dengan pemeriksaan SHA-256 dari paket Ubuntu msttcorefonts, menyimpan font dan lisensi di `data/fonts/`. Font tidak diganti diam-diam jika belum tersedia. `setup:full` juga menjalankan pemasangan font.

`npm test` menjalankan tes pada direktori runtime sementara yang terisolasi, sehingga tidak menyentuh data bot aktif. Tes render Arial dijalankan jika font telah dipasang.
