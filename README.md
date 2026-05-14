# IrO WhatsApp Bot

Bot WhatsApp pribadi berbasis Baileys. Login memakai QR di terminal, command memakai prefix koma, dan hanya pesan dari akun yang sedang login (`fromMe`) yang diproses.

## Ringkas

- Cocok dipindah ke Linux atau Windows lain.
- Dependensi Node bisa disiapkan otomatis.
- Tool sistem opsional bisa dicoba install otomatis untuk fitur penuh.
- Data runtime seperti `auth/`, `logs/`, `temp/`, dan data hasil bot tetap lokal dan tidak ikut ke GitHub.

## Persiapan

Wajib:

- Node.js `>= 20`
- npm

Opsional untuk fitur penuh:

- `ffmpeg`
- `ffprobe`
- `yt-dlp`
- `libreoffice` atau `soffice`

## Setup Cepat

Sesudah clone atau copy project ke mesin baru:

```bash
npm run setup
```

Jika PowerShell Windows memblokir `npm` karena execution policy, jalankan versi ini:

```powershell
npm.cmd run setup
```

Perintah ini akan:

- mengecek versi Node
- menjalankan `npm install` jika `node_modules` belum ada
- membuat folder runtime yang dibutuhkan
- membuat file data awal jika belum ada

Untuk mencoba memasang tool sistem otomatis juga:

```bash
npm run setup:full
```

Catatan:

- Windows: script memakai `winget` bila tersedia.
- Linux: script mencoba `apt-get`, `dnf`, `pacman`, atau `zypper`.
- Bila package manager tidak cocok atau butuh hak akses `sudo`, install manual tetap bisa.

## Cek Kesiapan

```bash
npm run doctor
```

Hasilnya akan menampilkan status `ffmpeg`, `ffprobe`, `yt-dlp`, dan `LibreOffice/soffice`.

## Jalankan Bot

```bash
npm start
```

Scan QR yang muncul di terminal. Session akan disimpan di folder `auth/`.

## Fitur yang Bergantung Tool Sistem

- Sticker, media, dan sebagian konversi: butuh `ffmpeg`
- YouTube MP3/MP4: butuh `yt-dlp`, dan MP3 juga butuh `ffmpeg`
- Office ke PDF: butuh `libreoffice` atau `soffice`

Bot tetap bisa start tanpa tool tersebut. Command yang membutuhkan tool hilang akan memberi pesan error yang jelas.

Catatan YouTube:

- Command `,yt` memakai fallback untuk beberapa error YouTube seperti HTTP 400/403 dan `nsig extraction failed`.
- Jika YouTube tetap menolak, update `yt-dlp` ke versi terbaru. Beberapa video bisa membutuhkan cookies browser atau PO token YouTube.

Catatan view-once:

- `,rs [target]` memakai cache sementara selama bot hidup.
- Cache hanya menyimpan metadata pesan terbaru, bukan file media view-once permanen.
- Jika bot restart atau media sudah tidak valid di server WhatsApp, view-once lama mungkin tidak bisa diambil.

## Membuat Repo Baru dan Push ke GitHub

Pastikan file sensitif tetap tidak ikut commit. `.gitignore` proyek ini sudah mengabaikan:

- `auth/`
- `logs/`
- `temp/`
- `node_modules/`
- file data runtime yang berubah saat bot jalan

Langkah umum:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

Kalau mau membuat repo kosong dulu di GitHub, buat tanpa centang `README`, `.gitignore`, dan license agar tidak bentrok dengan isi lokal.

## Pindah Device

Saat pindah ke Linux atau Windows lain:

1. clone repo
2. jalankan `npm run setup`
3. jika ingin fitur penuh, jalankan `npm run setup:full`
4. cek hasil dengan `npm run doctor`
5. jalankan `npm start`
6. scan QR lagi bila folder `auth/` tidak ikut dipindah

Jika ingin tetap login tanpa scan ulang, pindahkan folder `auth/` secara manual dan simpan dengan aman. Jangan upload folder itu ke GitHub.

## Command

- `,help`
- `,status`
- `,yt <link> <mp3|mp4> [360|480|720|1080]`
- `,info <nomor telepon>`
- `,save <judul> [teks awal]`
- `,load`
- `,load <id|judul>`
- `,load del <id|judul>`
- `,s [author] [title]`
- `,rs`
- `,rs <nama grup|nama kontak|nomor telepon>`
- `,task [count|loop] "<teks>" <jam> [menit] [detik] [tanggal]`
- `,ltask`
- `,ltask true <id>`
- `,ltask false <id>`
- `,ltask del <id>`
- `,topdf`
- `,end`
- `,cancel`

Folder runtime dibuat otomatis: `auth/`, `data/`, `logs/`, `temp/`.

## Alur PDF

Cara normal:

1. ketik `,topdf`
2. reply media pertama dengan teks/caption `1`
3. reply media kedua dengan teks/caption `2`
4. lanjutkan sesuai urutan halaman
5. ketik `,end`

Mode lama tetap bisa dipakai: reply media langsung dengan `,topdf` atau `,topdf 1`.

## Save/Load

`,save` sekarang mencoba menyimpan konten umum WhatsApp: teks, image, video, audio, dokumen, sticker, lokasi/maps, kontak, multi-kontak, poll, dan event. Tipe yang belum bisa dikirim ulang native akan disimpan sebagai fallback supaya tetap ada jejak saat `,load`.
