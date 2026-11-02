# Panduan Build APK — Belgindo Inventory

**Nama APK:** Belgindo Inventory  
**Package:** `id.co.belgindoraya.inventory`  
**Keystore domain:** belgindoraya.co.id  
**Password keystore:** Belgindo2026  
**PT Belgindo Raya — Grobogan, Jawa Tengah, Indonesia**

## Ringkasan

Aplikasi asli adalah SPA + backend Python (SQLite / Firebase).  
Untuk APK lapangan (input penerimaan lokal & impor), versi yang disiapkan adalah **WebView + aset lokal** yang menjalankan antarmuka yang sama persis (warna, ikon, logika, rumus, struktur) dengan adaptasi:

- Semua kolom input otomatis HURUF KAPITAL (kecuali username, password, dan field konfigurasi Firebase) — sudah ada di source asli.
- Fitur cetak & ekspor disembunyikan.
- Double-click & klik-kanan diganti **long-press** (tahan 0,55 detik) yang memunculkan menu konteks yang sama.
- Sidebar & drawer mobile sudah ada di CSS asli; diperkuat untuk sentuhan.

## Cara 1 — Build via GitHub Actions (paling mudah dari ponsel)

1. Buat repository baru di GitHub (bisa dari ponsel).
2. Upload **seluruh isi folder ini** ke root repository (bukan di dalam subfolder lain).
3. Buat keystore di komputer (sekali saja):

```bash
keytool -genkey -v -keystore belgindo.keystore -alias belgindoraya \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass Belgindo2026 -keypass Belgindo2026 \
  -dname "CN=Belgindo Inventory, OU=IT, O=PT Belgindo Raya, L=Grobogan, ST=Jawa Tengah, C=ID"
```

4. Encode keystore:

```bash
base64 -w0 belgindo.keystore > keystore.b64
```

5. Di GitHub → Settings → Secrets and variables → Actions, tambahkan secrets:

| Secret Name          | Value                          |
|----------------------|--------------------------------|
| `KEYSTORE_BASE64`    | isi file keystore.b64          |
| `KEYSTORE_PASSWORD`  | Belgindo2026                   |
| `KEY_ALIAS`          | belgindoraya                   |
| `KEY_PASSWORD`       | Belgindo2026                   |

6. Jalankan workflow **Build Belgindo Inventory APK** (Actions → Run workflow).
7. Download artifact APK setelah selesai.

## Cara 2 — Build lokal dengan Android Studio

1. Install Android Studio.
2. Buka folder `android-webview` sebagai project.
3. Pastikan aset di `app/src/main/assets/` berisi salinan terbaru folder `web/`.
4. Buat keystore seperti di atas, letakkan di `android-webview/belgindo.keystore`.
5. Tambahkan signing config di `app/build.gradle` (lihat template di bawah).
6. Build → Generate Signed Bundle / APK → APK → release.

### Template signing di `app/build.gradle`

```gradle
android {
    ...
    signingConfigs {
        release {
            storeFile file('../belgindo.keystore')
            storePassword 'Belgindo2026'
            keyAlias 'belgindoraya'
            keyPassword 'Belgindo2026'
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
        }
    }
}
```

## Cara 3 — Mode Firebase (direkomendasikan untuk lapangan)

1. Ikuti `README-FIREBASE.md` untuk menyiapkan Firestore.
2. Isi konfigurasi Firebase di aplikasi (halaman setup).
3. APK WebView akan bekerja offline-first + sinkron ke cloud.
4. Tidak perlu menjalankan server Python di perangkat.

## Mode Server Lokal (desktop / komputer kantor)

Jalankan seperti biasa:

```bash
python app.py
```

atau `./jalankan.sh`

## Catatan penting

- Struktur, fungsi, rumus, dan logika di folder `server/` + `web/` **tidak diubah** kecuali penambahan long-press dan CSS penyembunyian cetak/ekspor.
- Ikon APK: `icon.png` (warna hijau tua #0c2f26 + emas #e8c987 sesuai favicon asli).
- Untuk mengganti ikon launcher Android, salin `icon.png` ke `android-webview/app/src/main/res/mipmap-*/ic_launcher.png` (atau gunakan Android Studio Image Asset).

## Kontak perusahaan

PT Belgindo Raya  
Grobogan, Jawa Tengah, Indonesia  
Domain keystore: belgindoraya.co.id
