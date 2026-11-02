# Belgindo Inventory (APK Project)

**PT Belgindo Raya — Grobogan, Jawa Tengah, Indonesia**

Proyek ini berisi **source lengkap** aplikasi inventori kayu Belgindo Raya yang sudah disiapkan untuk dibuild menjadi APK Android.

## Isi folder

| Folder / File | Keterangan |
|---------------|------------|
| `app.py` + `server/` + `web/` | Source asli lengkap (logika, rumus, UI, warna, ikon dipertahankan) |
| `android-webview/` | Project Android WebView siap build |
| `icon.png` | Ikon APK (hijau + emas sesuai brand) |
| `PANDUAN_BUILD_APK.md` | **Baca ini** untuk cara build APK |
| `.github/workflows/build-apk.yml` | Workflow GitHub Actions |

## Fitur yang disesuaikan untuk APK lapangan

- Fokus input **Penerimaan Lokal** & **Penerimaan Impor**
- Semua kolom input → **HURUF KAPITAL** otomatis (kecuali username/password & konfigurasi)
- Fitur **cetak & ekspor dihilangkan**
- Double-click & klik-kanan diganti **long-press** (tahan layar) → menu konteks yang sama
- UI, warna, ikon, struktur, fungsi, rumus, dan logika **tidak dikurangi**

## Cara cepat

1. Baca `PANDUAN_BUILD_APK.md`
2. Push seluruh folder ini ke GitHub
3. Jalankan Actions → Build APK
4. Download file `.apk`

Keystore: `belgindoraya.co.id` / password `Belgindo2026`
