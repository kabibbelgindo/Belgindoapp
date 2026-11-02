# Panduan Edisi Firebase (Firestore) — PT. Belgindo Raya Inventory v1.0.99

Edisi ini menjalankan aplikasi **sepenuhnya di sisi browser**: antarmuka dibuka
dari folder ini, seluruh data tersimpan di **Cloud Firestore** proyek
**`belgindoinventory`** dengan **paket Spark (gratis)** dan **tanpa Firebase Auth**.

## 0. Kenapa login bisa gagal sebelumnya?

Aplikasi hanya bisa masuk bila dua hal ini sudah benar di proyek Firebase:

1. **Database Firestore sudah dibuat** — tanpa database, aplikasi tidak punya
   tempat menyimpan akun maupun data (inilah penyebab paling umum gagal login).
2. **Aturan keamanan sudah diterbitkan** — database baru mode produksi menolak
   semua akses sampai aturan dipasang.

Mulai versi ini, aplikasi **memeriksa keduanya secara otomatis**: bila belum
siap, layar **Penyiapan Firestore** muncul dengan tombol langsung ke console
dan tombol **Salin aturan** — ikuti saja petunjuk di layar. Langkah lengkapnya
tetap ditulis di bawah.

## 1. Aktifkan Firestore (sekali saja, tanpa instal apa pun)

1. Buka <https://console.firebase.google.com/project/belgindoinventory/firestore>.
2. Klik **Create database** → pilih **Production mode** → lokasi bebas
   (mis. `asia-southeast2` Jakarta) → **Create**.
3. Masih di halaman Firestore, buka tab **Rules** → hapus isinya → tempel
   aturan dari berkas `firestore.rules` (atau tombol **Salin aturan** di layar
   penyiapan aplikasi) → klik **Publish**.

Selesai. Tidak perlu Node.js, npm, atau Firebase CLI untuk langkah ini.

## 2. Menjalankan aplikasi

Klik dua kali **`jalankan.bat`** (Windows) atau jalankan `./jalankan.sh`
(macOS/Linux), lalu buka <http://localhost:8000>. Python 3 sudah cukup —
tidak ada dependensi lain.

Data TIDAK tersimpan di komputer: seluruh perangkat yang membuka aplikasi
(memakai koneksi internet) melihat dan menulis data yang sama di Firestore.

Bila ingin aplikasi terbuka dari internet tanpa server lokal, publikasikan
ke Firebase Hosting (opsional, butuh Node.js 18+):

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting
# terbuka di https://belgindoinventory.web.app
```

## 3. Login pertama

Saat pertama dibuka dengan database kosong, aplikasi hanya menanam **dua akun
login**. Master kayu, penjual, rit, nota, tally, rekap, mutasi dan opname
dibiarkan kosong — semuanya diisi sendiri oleh pengguna.

| Akun | Password awal | Peran |
| --- | --- | --- |
| `admin` | `admin123` | Admin operasional |
| `administrator` | `administrator` | Administrator Utama tersembunyi |

Keduanya langsung masuk tanpa dipaksa mengganti password; penggantian password
bersifat sukarela lewat menu Ganti Password. Password disimpan sebagai hash
PBKDF2-SHA256 (200.000 iterasi) — sama dengan edisi lokal.

**Login tanpa batas percobaan (baru di 1.0.98):** tidak ada lagi pembatas
percobaan login berdasarkan detik — salah password berapa kali pun, coba lagi
langsung bisa. Akun awal yang **belum pernah dipakai masuk** dan belum pernah
diganti passwordnya otomatis dipulihkan ke password awal di atas (termasuk bila
database lama masih menyimpan `admin`/`123`). Setelah akun berhasil masuk
sekali, password yang tersimpan dihormati sepenuhnya.

**Keamanan data multi-perangkat (baru di 1.0.99):**

- *Tidak ada lagi data tertimpa.* Dua perangkat yang menyimpan bersamaan dulu
  bisa memakai id yang sama sehingga satu catatan hilang diam-diam. Kini setiap
  penyimpanan memakai kunci versi (rev) di Firestore; bila perangkat lain
  menyimpan lebih dulu, aplikasi otomatis mengambil data terbaru lalu
  mengulang aksi Anda.
- *Hemat kuota Spark.* Perangkat hanya menarik dokumen yang berubah (bukan
  membaca ulang seluruh database) tiap ada penyimpanan dari perangkat lain.
  Riwayat perubahan disimpan di koleksi `_meta` yang sudah diizinkan aturan —
  **aturan Firestore tidak perlu diubah**.
- *Operasi diantre.* Beberapa permintaan serentak dari satu halaman tidak lagi
  saling bertabrakan.
- *Stok tidak boleh minus pada tanggal mana pun.* Barang keluar, mutasi,
  hapus baris nota, dan ubah nota ditolak bila tanggalnya membuat saldo minus
  di riwayat (mis. mutasi bertanggal sebelum barang masuk), walaupun stok hari
  ini cukup.

**Alur Penerimaan Lokal (baru di 1.0.98):** penjual → **rit** → **nota**. Tombol
`+ Rit` kini ada di kolom Rit; menekan `+ Nota` tanpa rit membuka formulir rit
lebih dahulu, dan setelah rit dibuat formulir nota pertama langsung terbuka.

**Pembersihan data contoh (baru di 1.0.97):** bila proyek masih berisi data
contoh bawaan versi 1.0.96, aplikasi menghapusnya sekali pada saat dibuka
(melalui penanda `BERSIHKAN_DATA_DEMO` di log aktivitas). Hanya baris dengan
nama dan catatan khas contoh yang dibuang; data nyata — termasuk master yang
masih dirujuk — dipertahankan.

**Perbaikan otomatis (baru di 1.0.96):** bila koleksi `users` ternyata berisi
dokumen sisa/uji tanpa `password_hash` (penyebab "Username atau password
salah" terus-menerus pada versi lama), aplikasi menghapus dokumen rusak itu
dan menulis ulang kedua akun di atas secara otomatis.

## 4. Jika login masih gagal

| Gejala | Penyebab | Solusi |
| --- | --- | --- |
| Layar **"Database Firestore belum dibuat"** | Firestore belum diaktifkan | Ikuti langkah 1 di atas, lalu klik **Periksa ulang** |
| Layar **"Aturan keamanan menolak akses"** | Aturan belum diterbitkan | Tab Rules → tempel → **Publish** → **Periksa ulang** |
| "Username atau password salah" terus | Password memang salah, atau database berisi data lama | Coba `administrator` / `administrator`; bila tetap gagal, biarkan aplikasi memperbaiki otomatis (bagian 3) |
| Layar "Tidak dapat menghubungi Firestore" | Internet/VPN/firewall | Periksa koneksi ke `firestore.googleapis.com` |

Layar penyiapan selalu menampilkan nama proyek yang dipakai
(`belgindoinventory`) — pastikan console yang dibuka juga proyek itu.

## 5. Perbedaan perilaku dibanding edisi lokal

| Aspek | Edisi lokal | Edisi Firebase |
| --- | --- | --- |
| Database | SQLite di folder `data/` | Cloud Firestore (koleksi 1:1 dengan tabel) |
| Server | Python wajib berjalan | Python hanya penyaji berkas; data lewat Firestore |
| Ekspor Excel | `.xlsx` (openpyxl) | `.csv` (dibuka Excel/LibreOffice, delimiter `;`, UTF-8 BOM) |
| PDF tally/rekap/opname | Berkas `.pdf` dari server | Jendela cetak browser (Simpan sebagai PDF) |
| Backup | Salinan `.db` | JSON semua koleksi (menu Backup) |
| Reset data | Backup otomatis lalu reset | Unduh backup manual dulu, lalu reset |
| Multi-pengguna | Satu server LAN | Semua perangkat online melihat data yang sama |
| Isi awal database | Kosong — hanya dua akun login | Sama (`/?store=memory` untuk mencoba tanpa jaringan) |

Angka, aturan bisnis, validasi, nomor dokumen, dan alur kerja identik antara
kedua edisi — keduanya dibandingkan otomatis lewat uji diferensial.

## 6. Keamanan & kuota paket Spark

- Karena berjalan **tanpa Firebase Auth**, `firestore.rules` membuka akses
  baca/tulis koleksi aplikasi kepada siapa pun yang membuka situs. Ini
  disengaja sesuai permintaan; jangan simpan data rahasia di proyek ini.
- Kuota gratis: 50 ribu pembacaan, 20 ribu penulisan, 1 GB penyimpanan per
  hari. Aplikasi membaca seluruh koleksi sekali saat dibuka, lalu hanya
  menulis per transaksi. Pantau di console → Firestore → Usage.

## 7. Struktur paket

```text
web/                    Antarmuka aplikasi (juga dipakai Firebase Hosting)
  js/api.js             Lapisan API: eksekusi langsung oleh mesin Firestore
  js/store/             Mesin data + seluruh logika bisnis edisi cloud
  js/firestore-setup.js Layar penyiapan Firestore (panduan otomatis)
  js/firebase-config.js Konfigurasi proyek belgindoinventory
firebase.json           Konfigurasi Hosting
firestore.rules         Aturan keamanan Firestore
.firebaserc             Alias proyek (belgindoinventory)
```

Edisi lokal (SQLite + Python) ada di paket terpisah; keduanya memakai nama dan
alur kerja yang sama: **PT. Belgindo Raya Inventory**.

## 8. Penyamaan konfigurasi dengan aplikasi 01

- `web/js/firebase-config.js` kini memakai nilai bawaan dan kunci override
  localStorage (`belgindo_firebase_config`) yang sama dengan aplikasi 01.
- `firestore.rules` kini juga mengizinkan koleksi `seller_contacts` (dipakai
  aplikasi 01) di samping `sellers`, sehingga satu set aturan melayani keduanya.
  Setelah memperbarui, terbitkan ulang aturan di Firebase Console → Rules.
- Catatan: kedua aplikasi tetap memiliki model data berbeda (id angka vs UUID,
  `sellers` vs `seller_contacts`, hash PBKDF2 vs SHA-256), sehingga isi data
  tidak otomatis identik hanya dengan konfigurasi yang sama.
