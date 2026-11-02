/* Layar penyiapan Firestore: bila database belum dibuat atau aturan keamanan
   belum diterbitkan, aplikasi menuntun pengguna langkah demi langkah di
   Firebase Console (tanpa perlu Node.js maupun Firebase CLI). */

export const FIRESTORE_RULES_TEXT = `rules_version = '2';

// Aturan keamanan PT. Belgindo Raya Inventory — edisi Firebase.
// Paket Spark TANPA Firebase Auth: seluruh pengunjung aplikasi dapat
// membaca dan menulis data melalui aplikasi. Jangan simpan data rahasia
// di proyek ini.
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{document=**} {
      allow read, write: if collection in [
        "users",
        "products",
        "product_active_prices",
        "master_spec_values",
        "master_price_values",
        "sellers",
        "seller_contacts",
        "storage_locations",
        "seller_rits",
        "transactions",
        "location_transfers",
        "tally_headers",
        "tally_items",
        "payment_recap_headers",
        "payment_recap_items",
        "stock_opname",
        "stock_opname_items",
        "stock_period_closures",
        "stock_period_closure_items",
        "activity_log",
        "sync_outbox",
        "_meta",
      ];
    }
  }
}`;

export function consoleFirestoreUrl(projectId) {
  return `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/firestore`;
}

export function setupGuide(status) {
  const projectId = status.projectId;
  const rulesStep = {
    title: "Terbitkan aturan keamanan",
    items: [
      `Di halaman Firestore, buka tab <strong>Rules</strong>.`,
      `Hapus isi aturan yang ada, lalu klik tombol <strong>Salin aturan</strong> di bawah dan tempel.`,
      `Klik <strong>Publish</strong>.`,
    ],
  };
  if (status.kind === "DB_MISSING") {
    return {
      headline: "Database Firestore belum dibuat",
      summary: `Proyek Firebase <strong>${escapeHtml(projectId)}</strong> masih belum memiliki database Firestore, sehingga aplikasi tidak punya tempat menyimpan data. Cukup dua langkah singkat di Firebase Console — tanpa instal apa pun:`,
      steps: [
        {
          title: "Buat database Firestore",
          items: [
            `Klik tombol <strong>Buka Firebase Console</strong> di bawah.`,
            `Klik <strong>Create database</strong> (Buat database).`,
            `Pilih <strong>Production mode</strong> (Mode produksi), lokasi bebas — mis. <strong>asia-southeast2</strong> (Jakarta), lalu klik <strong>Create</strong>.`,
          ],
        },
        rulesStep,
      ],
    };
  }
  if (status.kind === "RULES_DENIED") {
    return {
      headline: "Aturan keamanan Firestore menolak akses",
      summary: `Database proyek <strong>${escapeHtml(projectId)}</strong> sudah ada, tetapi aturannya masih menolak pembacaan/penulisan (mode produksi bawaan). Terbitkan aturan aplikasi berikut:`,
      steps: [rulesStep],
    };
  }
  if (status.kind === "NETWORK") {
    return {
      headline: "Tidak dapat menghubungi Firestore",
      summary: "Koneksi internet bermasalah atau jaringan memblokir <strong>firestore.googleapis.com</strong>. Periksa internet, VPN, dan firewall kantor, lalu periksa ulang.",
      steps: [],
    };
  }
  return {
    headline: "Firestore merespons dengan galat",
    summary: `Proyek <strong>${escapeHtml(projectId)}</strong> merespons, tetapi dengan galat yang tidak dikenal. Detail teknis: <code>${escapeHtml(status.detail || "-")}</code>`,
    steps: [],
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
