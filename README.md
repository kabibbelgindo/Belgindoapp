# PT. Belgindo Raya Inventory — Edisi Firebase (Firestore)

Aplikasi inventori dan audit kayu versi web modern, **edisi cloud**: seluruh data tersimpan di Firebase Firestore (paket Spark gratis, tanpa Firebase Auth) dan antarmuka dapat di-host di Firebase Hosting sebagai situs statis. Seluruh alur kerja dipertahankan: penerimaan lokal, tally dan afkir, rekap pembayaran, penerimaan impor, stok dan lot, barang keluar, mutasi lokasi, stok opname berurutan, laporan, ekspor, pengguna, backup, dan sinkronisasi.

Antarmuka berupa SPA tanpa build step. Backend memakai Python standard library dan SQLite, sehingga mudah dijalankan di komputer kantor maupun server lokal.

## Persyaratan

- Python 3.10 atau lebih baru (diuji pada Python 3.14).
- Paket Python untuk ekspor:
  - `openpyxl` untuk berkas Excel (`.xlsx`)
  - `reportlab` untuk dokumen PDF

Pasang dependensi:

```bash
pip install -r requirements.txt
```

## Menjalankan

Windows: klik dua kali `jalankan.bat`.

Semua sistem:

```bash
python app.py
```

Browser akan terbuka otomatis di `http://127.0.0.1:9393/`.

Opsi yang tersedia:

```bash
python app.py --host 0.0.0.0 --port 9393 --db data/belgindo.db
python app.py --no-browser
```

- `--host 0.0.0.0` membuka akses dari komputer lain di jaringan lokal.
- `--no-browser` tidak membuka browser otomatis.

Database baru dibuat kosong di `data/belgindo.db`: hanya dua akun login yang ditanam, seluruh master dan transaksi diisi sendiri. Backup sebelum reset disimpan di `data/backups/`, selain backup yang dapat diunduh dari menu Backup.

## Akun awal

| Akun | Password awal | Peran |
| --- | --- | --- |
| `admin` | `123` | Admin operasional |
| `administrator` | `administrator` | Administrator Utama tersembunyi |

Kedua akun langsung dapat dipakai login. Password diganti sukarela lewat menu Ganti Password — tidak ada paksaan ganti password saat login pertama.

Administrator Utama tidak tampil di daftar pengguna. Akun ini memiliki hak eksklusif untuk membuka kembali pengesahan opname dan mengaktifkan/menonaktifkan produk.

## Alur kerja utama

### 1. Data master
Lengkapi barang, penjual, lokasi gudang, spesifikasi ukuran, dan harga acuan. Produk dapat memiliki ukuran default (T, L, P) yang dipakai sebagai nilai awal formulir.

Satuan resmi:

- `T` = tebal, milimeter (mm)
- `L` = lebar, sentimeter (cm)
- `P` = panjang, sentimeter (cm)

Ukuran disimpan kanonik sebagai `LxTxP` dan ditampilkan sebagai `T × L × P`.

### 2. Penerimaan lokal
Pilih bulan, penjual, lalu rit. Setiap nota dapat berisi beberapa baris barang. Baris menambah stok di lokasi yang dipilih dan tidak boleh bertanggal melewati hari ini.

Nota yang sudah memiliki tally aktif atau rekap aktif terkunci dari penambahan baris. Ini menjaga agar cakupan dokumen tetap konsisten.

### 3. Tally dan afkir
Tally dibuat dari baris nota yang belum memiliki tally aktif. Setiap baris sumber hanya boleh memiliki satu tally aktif.

- Kategori `FRESH` memakai harga sumber.
- Kategori `AFKIR` bernilai harga 0.
- Nama pemeriksa minimal 3 karakter.
- Tally dapat dibatalkan, lalu dibuat ulang.

### 4. Rekap pembayaran
Satu nota hanya boleh memiliki satu rekap aktif. Rekap menutup nota dari penambahan baris sampai rekap dibatalkan.

### 5. Barang keluar dan mutasi
Barang keluar memilih lot masuk dan lokasi asal. Qty dibatasi oleh sisa lot dan stok lokasi. Mutasi memindahkan stok antar lokasi tanpa mengubah total persediaan.

Semua transaksi ditolak bila tanggalnya berada dalam periode yang sudah ditutup.

### 6. Penerimaan impor
Penerimaan impor mendukung input manual dan payload hasil pemindaian barcode/QR. Barang impor otomatis mendapat kode `IMP/<SLUG>` dan nomor transaksi `IMP-...`. Dimensi bebas, pemasok disimpan pada transaksi, dan barcode disimpan pada catatan.

Format payload yang didukung:

```json
{"barcode":"IMP-99213","product_name":"KAYU MERANTI","size":"20x40x400","qty":12,"price":7200000,"location":"GD-A"}
```

`size` memakai urutan kanonik `LxTxP` (lebar, tebal, panjang). Kolom `thickness`, `width`, dan `length` yang ditulis eksplisit akan diprioritaskan.

### 7. Stok dan kartu stok
Stok dihitung dari penerimaan, barang keluar, mutasi, dan penyesuaian opname. Lot adalah baris penerimaan; sisa lot = qty masuk − barang keluar yang tertaut.

Kartu stok menampilkan saldo awal, pergerakan, dan saldo akhir untuk produk, ukuran, serta lokasi tertentu. Lokasi kosong berarti khusus "Tanpa lokasi", bukan seluruh lokasi. Antarmuka memilih lokasi dengan stok terbesar secara otomatis agar langsung menampilkan data yang relevan.

### 8. Stok opname
Alur opname berurutan:

1. Mulai sesi dengan tanggal cut-off.
2. Hitung fisik setiap baris.
3. Tambahkan barang temuan bila ada.
4. Isi otomatis baris yang belum dihitung bila diperlukan.
5. Sahkan; penyesuaian diposting ke buku stok dengan nomor `OPN-...`.
6. Tutup periode untuk mengunci transaksi sampai tanggal cut-off.

Pengesahan mensyaratkan seluruh baris sudah dihitung dan memiliki alasan. Hanya periode terakhir yang berstatus disahkan dapat dibuka kembali, dan hanya oleh Administrator Utama. Membuka kembali akan menghapus penyesuaian `OPN` terkait.

### 9. Laporan dan ekspor
Delapan laporan tersedia: transaksi, stok, penjual, tally, rekap, mutasi, impor, dan aktivitas. Setiap laporan dapat dicetak atau diekspor ke Excel.

### 10. Administrasi
- Pengguna: tambah akun, ubah peran, nonaktifkan, reset password, hapus akun tanpa riwayat.
- Aktivitas: jejak audit aksi penting.
- Sinkronisasi: status antrean sinkronisasi.
- Backup: unduh database, lihat ringkasan, dan reset data dengan konfirmasi teks serta password admin.

## Rumus

Volume per baris:

```text
m³ = L × T × P × qty ÷ 10.000.000
```

Dengan `L` dan `P` dalam cm, `T` dalam mm, dan `qty` dalam batang.

Nilai baris:

```text
jumlah = m³ × harga per m³
```

Pembulatan nilai memakai `ROUND_HALF_UP` dua desimal. Total nota, tally, rekap, laporan, dan ekspor mengikuti rumus yang sama.

Saldo stok:

```text
stok = total masuk − total keluar ± mutasi + penyesuaian opname
```

## Aturan penguncian dan konsistensi

- Tanggal transaksi tidak boleh melewati hari ini.
- Periode yang sudah ditutup mengunci penerimaan, barang keluar, mutasi, tally, rekap, dan opname pada tanggal terkait.
- Nota dengan tally aktif atau rekap aktif tidak dapat menerima baris baru.
- Satu baris nota hanya boleh memiliki satu tally aktif.
- Satu nota hanya boleh memiliki satu rekap aktif.
- Pembatalan dokumen ditolak bila tanggal dokumen berada dalam periode terkunci.
- Seluruh aksi penting dicatat pada log aktivitas.

## Keamanan

- Password disimpan dengan PBKDF2-SHA256 200.000 iterasi dan salt acak.
- Sesi memakai cookie `br_sid` yang `HttpOnly` dan `SameSite=Lax`, berlaku 12 jam.
- Permintaan mutasi mewajibkan header `X-Requested-With`.
- CSP ketat, tanpa script inline, serta header keamanan lain (`X-Frame-Options`, `nosniff`, dan sebagainya).
- Pembatasan percobaan login: 5 kegagalan per 60 detik, diikuti kunci 30 detik.
- Backup memakai mekanisme backup SQLite yang aman saat server berjalan.

Aplikasi ini sendiri memakai HTTP. Bila diakses dari luar jaringan lokal, letakkan di belakang reverse proxy TLS (HTTPS) dan jangan membuka port aplikasi langsung ke internet. Batasi akses jaringan dan lindungi folder `data/` karena berisi database serta backup.

## Pengujian

Gunakan database terpisah. Skrip uji mengubah data dan password akun pada database yang diuji.

```bash
python app.py --db data/uji.db --port 9494 --no-browser
python tests/http_smoke.py --base http://127.0.0.1:9494 --password "Rahasia#2026"
python tests/opname_http.py --base http://127.0.0.1:9494 --password "Rahasia#2026" --primary-password "Primary#2026"
```

Jangan menjalankan skrip uji pada database produksi.

## Struktur proyek

```text
app.py                 Titik masuk server dan penyajian SPA
server/
  api.py               Routing REST, sesi, dan versioning
  auth.py              Login, password, dan sesi
  core.py              Database, utilitas, dan inisialisasi
  schema.py            Skema SQLite
  seed.py              Akun awal & pembersihan data contoh versi lama
  stock.py             Stok, lot, keluar, mutasi, kartu stok
  documents.py         Penerimaan, tally, dan rekap
  opname.py            Siklus stok opname
  reports.py           Laporan dan ekspor
  exports.py           Pembuat XLSX dan PDF
  importing.py         Penerimaan impor dan parser payload
  admin.py             Pengguna, backup, reset, sinkronisasi
web/
  index.html           Kerangka SPA
  css/app.css          Tema antarmuka
  js/                  Router, API, komponen, dan halaman
tests/                 Uji integrasi HTTP
data/                  Database, backup, dan log (dibuat otomatis)
```

## Pemecahan masalah

- **Port dipakai:** jalankan dengan port lain, misalnya `python app.py --port 9394`.
- **Ekspor/PDF gagal:** pastikan `openpyxl` dan `reportlab` terpasang.
- **Lupa password Administrator Utama:** hentikan server, buat backup database, lalu pulihkan dari backup yang diketahui passwordnya. Tidak ada jalur reset tanpa autentikasi.
- **Ingin memulai dari nol:** unduh backup terlebih dahulu, lalu gunakan menu Backup → Reset Data. Menghapus `data/belgindo.db` saat server berhenti juga akan membuat database kosong (hanya dua akun login) pada start berikutnya.
- **Database terkunci:** pastikan hanya satu proses server yang memakai berkas database yang sama.
