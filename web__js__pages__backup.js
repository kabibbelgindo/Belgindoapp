import { api } from "../api.js";
import { icon } from "../icons.js";
import { state } from "../state.js";
import {
  badge, confirmDialog, esc, fmtDateTime, fmtQty, infoBanner, localISO, toast,
} from "../ui.js";
import { refreshAllMeta } from "./common.js";

const page = {
  root: null,
  seq: 0,
  overview: null,
  downloading: false,
  resetting: false,
  lastBackup: null,
};

function downloadButtons() {
  return Array.from(page.root?.querySelectorAll("[data-download-backup]") || []);
}

function localStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${localISO(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function summarySkeleton() {
  return `<div class="meta-grid">
    ${[
      ["Barang aktif", "…"],
      ["Penjual aktif", "…"],
      ["Lokasi", "…"],
      ["Pengguna aktif", "…"],
      ["Tally aktif", "…"],
      ["Rekap aktif", "…"],
    ].map(([label, value]) => `<div class="meta-cell"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")}
  </div>
  <p class="field-help" style="margin-top:10px">Membaca ringkasan basis data…</p>`;
}

function overviewMarkup(overview) {
  const counts = overview?.counts || {};
  const unclosed = overview?.unclosed;
  const locked = overview?.locked_through_display || state.meta?.lock?.locked_through_display;
  const cells = [
    ["Barang aktif", counts.products],
    ["Penjual aktif", counts.sellers],
    ["Lokasi", counts.locations],
    ["Pengguna aktif", counts.users],
    ["Tally aktif", counts.tallies],
    ["Rekap aktif", counts.recaps],
  ];
  const warnings = [];
  if (unclosed) {
    warnings.push(infoBanner(
      `Opname periode ${unclosed.period_start_display} — ${unclosed.period_end_display} masih berjalan. Reset akan menghapus sesi ini beserta hasil penghitungannya.`,
      { tone: "warn", iconName: "clock", title: "Ada opname yang belum ditutup" },
    ));
  }
  if (locked) {
    warnings.push(infoBanner(
      `Periode stok terkunci sampai ${locked}. Setelah reset, kunci periode ikut dilepas agar pencatatan baru dapat dimulai.`,
      { tone: "warn", iconName: "lock", title: "Periode sedang terkunci" },
    ));
  }
  return `<div class="meta-grid">
    ${cells.map(([label, value]) => `<div class="meta-cell"><span>${esc(label)}</span><strong>${esc(fmtQty(value ?? 0))}</strong></div>`).join("")}
  </div>
  <div class="inline-meta" style="margin-top:12px">
    <span>${icon("lock", 13)} Terkunci sampai <strong>${esc(locked || "Belum dikunci")}</strong></span>
    <span>${icon("history", 13)} Opname berjalan <strong>${unclosed ? `${esc(fmtQty(unclosed.summary?.counted))} / ${esc(fmtQty(unclosed.summary?.items))} baris` : "Tidak ada"}</strong></span>
  </div>
  ${warnings.length ? `<div style="margin-top:12px" class="stack-sm">${warnings.join("")}</div>` : ""}`;
}

async function loadOverview() {
  const holder = page.root?.querySelector("#backup-stats");
  if (!holder) return;
  const seq = ++page.seq;
  try {
    const overview = await api.get("/api/dashboard");
    if (seq !== page.seq || !page.root) return;
    page.overview = overview;
    holder.innerHTML = overviewMarkup(overview);
  } catch (error) {
    if (seq !== page.seq || !page.root) return;
    holder.innerHTML = `<p class="field-help">${esc(error.message || "Ringkasan basis data tidak dapat dimuat.")}</p>`;
  }
}

function showLastBackup() {
  const holder = page.root?.querySelector("#backup-result");
  if (!holder) return;
  if (!page.lastBackup) {
    holder.innerHTML = "";
    return;
  }
  holder.innerHTML = `<div class="notice-line" style="margin-top:12px">${icon("checkCircle", 15)}
    <span>Terakhir diunduh: <strong>${esc(page.lastBackup.filename)}</strong> · ${esc(fmtDateTime(page.lastBackup.at))}</span>
  </div>`;
}

async function downloadBackup() {
  if (page.downloading) return;
  page.downloading = true;
  const buttons = downloadButtons();
  const originals = buttons.map((button) => button.innerHTML);
  buttons.forEach((button) => {
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner-xs"></span><span>Menyiapkan…</span>`;
  });
  try {
    const filename = await api.download("/api/admin/backup", {}, "backup-belgindo-inventory.db");
    page.lastBackup = { filename, at: localStamp() };
    showLastBackup();
    toast.success(`Backup ${filename} berhasil diunduh.`);
  } catch (error) {
    toast.error(error?.message || "Backup gagal diunduh.");
  } finally {
    page.downloading = false;
    buttons.forEach((button, index) => {
      button.disabled = false;
      button.innerHTML = originals[index];
    });
  }
}

async function resetTransactionData(button) {
  if (page.resetting) return;
  const result = await confirmDialog({
    title: "Reset seluruh data transaksi?",
    message: "Tindakan ini menghapus data operasional secara permanen. Data master dan akun pengguna tetap disimpan.",
    eyebrow: "Zona berbahaya",
    confirmLabel: "Reset data transaksi",
    danger: true,
    iconName: "alert",
    requireText: "RESET",
    requirePassword: true,
    details: `<div class="backup-list">
      <div class="backup-row">${icon("trash", 15)}<div><strong>Dihapus:</strong> rit, nota, transaksi stok, tally, rekap pembayaran, mutasi lokasi, opname, penutupan periode, log aktivitas, dan antrean outbox.</div></div>
      <div class="backup-row">${icon("shield", 15)}<div><strong>Dipertahankan:</strong> pengguna, barang, harga aktif, ukuran, penjual, lokasi, dan pengaturan aplikasi.</div></div>
      <div class="backup-row">${icon("database", 15)}<div><strong>Backup otomatis:</strong> dibuat di folder penyimpanan server sebelum data dihapus.</div></div>
    </div>`,
  });
  if (!result.confirmed) return;
  page.resetting = true;
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner spinner-xs"></span><span>Mereset…</span>`;
  try {
    const data = await api.post("/api/admin/reset-transactions", {
      password: result.password,
      confirmation: result.confirmation,
    });
    const holder = page.root?.querySelector("#reset-result");
    if (holder) {
      holder.innerHTML = infoBanner(
        `${fmtQty(data.deleted_tables?.length)} tabel transaksi dikosongkan. Backup otomatis tersimpan di server sebagai ${data.backup}. Unduh backup terbaru bila Anda perlu salinan di perangkat ini.`,
        { tone: "success", iconName: "checkCircle", title: "Data transaksi telah direset" },
      );
    }
    page.lastBackup = null;
    showLastBackup();
    toast.success("Reset selesai. Backup otomatis dibuat di server.");
    await refreshAllMeta().catch(() => {});
    await loadOverview();
  } catch (error) {
    toast.error(error?.message || "Reset data gagal dijalankan.");
  } finally {
    page.resetting = false;
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

export async function render(root) {
  page.root = root;
  page.seq += 1;
  page.overview = null;
  page.downloading = false;
  page.resetting = false;
  root.innerHTML = `
    <div class="page-head">
      <div>
        <span class="eyebrow">${icon("shield", 13)} Administrasi data</span>
        <h1>Backup &amp; Reset</h1>
        <p>Amankan salinan basis data sebelum pemeliharaan, lalu bersihkan data transaksi bila perlu memulai siklus pencatatan baru.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" type="button" data-download-backup>${icon("download", 16)} Unduh backup</button>
      </div>
    </div>
    <div class="system-grid">
      <div class="stack">
        <div class="card">
          <div class="card-header with-line">
            <div class="section-head" style="margin:0">
              <div>
                <h2>Salinan basis data</h2>
                <p>Satu berkas JSON berisi seluruh koleksi Firestore PT. Belgindo Raya Inventory.</p>
              </div>
              ${badge("Disarankan", "green")}
            </div>
          </div>
          <div class="card-body">
            <div class="backup-list">
              <div class="backup-row">${icon("database", 15)}<div><strong>Lengkap.</strong> Master barang, pengguna, rit, nota, transaksi stok, tally, rekap, opname, dan pengaturan aplikasi tersimpan dalam satu berkas.</div></div>
              <div class="backup-row">${icon("shield", 15)}<div><strong>Konsisten.</strong> Salinan dibuat dengan mekanisme backup SQLite sehingga aman diambil saat aplikasi sedang digunakan.</div></div>
              <div class="backup-row">${icon("clock", 15)}<div><strong>Bertanggal.</strong> Nama berkas memuat tanggal dan waktu pembuatan agar mudah diarsipkan.</div></div>
            </div>
            <div class="section-divider"></div>
            <div class="hero-actions">
              <button class="btn btn-primary" type="button" data-download-backup>${icon("download", 15)} Unduh backup (.db)</button>
              <span class="field-help">Simpan berkas di tempat aman. Berkas berisi data pengguna dan transaksi.</span>
            </div>
            <div id="backup-result"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header with-line">
            <div class="section-head" style="margin:0">
              <div>
                <h2>Ringkasan data saat ini</h2>
                <p>Gambaran isi basis data sebelum Anda melakukan pemeliharaan.</p>
              </div>
              ${badge("Basis data lokal", "neutral")}
            </div>
          </div>
          <div class="card-body">
            <div id="backup-stats">${summarySkeleton()}</div>
          </div>
        </div>
        <div class="card danger-zone">
          <div class="card-header with-line">
            <div class="danger-title">
              ${icon("alert", 19)}
              <div>
                <strong>Reset seluruh data transaksi</strong>
                <span>Tindakan permanen — tidak dapat dibatalkan dari aplikasi.</span>
              </div>
            </div>
          </div>
          <div class="card-body">
            ${infoBanner("Unduh backup terlebih dahulu. Reset menghapus data operasional dan mengosongkan periode agar pencatatan dapat dimulai dari awal.", {
              tone: "danger",
              iconName: "alert",
              title: "Pastikan salinan sudah aman",
            })}
            <div class="backup-list" style="margin-top:12px">
              <div class="backup-row">${icon("trash", 15)}<div><strong>Dihapus:</strong> rit, nota, transaksi masuk/keluar, tally, rekap pembayaran, mutasi lokasi, opname, penutupan periode, log aktivitas, dan antrean outbox.</div></div>
              <div class="backup-row">${icon("shield", 15)}<div><strong>Dipertahankan:</strong> pengguna, barang, harga, ukuran, penjual, lokasi, dan pengaturan aplikasi.</div></div>
              <div class="backup-row">${icon("database", 15)}<div><strong>Pengaman:</strong> server membuat backup otomatis ke folder backup sebelum menghapus data.</div></div>
            </div>
            <div class="hero-actions" style="margin-top:14px">
              <button class="btn btn-danger" type="button" data-reset-data>${icon("trash", 15)} Reset data transaksi</button>
              <span class="field-help">Memerlukan ketikan RESET dan password administrator.</span>
            </div>
            <div id="reset-result"></div>
          </div>
        </div>
      </div>
      <aside class="stack">
        <div class="card">
          <div class="card-pad">
            <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Alur aman</h2></div></div>
            <ol class="hint-list">
              <li>Unduh backup dan periksa apakah berkas tersimpan.</li>
              <li>Tinjau laporan, outbox, serta opname yang masih berjalan.</li>
              <li>Lakukan reset hanya bila data operasional memang akan dimulai ulang.</li>
              <li>Catat nama backup otomatis yang disebutkan setelah reset.</li>
            </ol>
          </div>
        </div>
        <div class="card">
          <div class="card-pad">
            <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Cakupan backup</h2></div></div>
            <div class="backup-list">
              <div class="backup-row">${icon("checkCircle", 15)}<div><strong>Seluruh tabel.</strong> Termasuk akun, hak akses, master, dan riwayat operasional.</div></div>
              <div class="backup-row">${icon("checkCircle", 15)}<div><strong>Tanpa koneksi internet.</strong> Seluruh proses berjalan di server lokal.</div></div>
              <div class="backup-row">${icon("checkCircle", 15)}<div><strong>Dapat diarsipkan.</strong> Simpan per tanggal agar riwayat pemeliharaan mudah ditelusuri.</div></div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-pad">
            <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Hak akses</h2></div></div>
            <p class="field-help">Halaman ini hanya dapat dibuka administrator. Reset memverifikasi password akun yang sedang masuk dan tercatat pada log aktivitas.</p>
            <div class="section-divider"></div>
            <div class="notice-line">${icon("shield", 15)} <span>Backup berisi data sensitif — jangan dibagikan.</span></div>
          </div>
        </div>
      </aside>
    </div>`;

  downloadButtons().forEach((button) => {
    button.addEventListener("click", () => downloadBackup());
  });
  root.querySelector("[data-reset-data]")?.addEventListener("click", (event) => {
    resetTransactionData(event.currentTarget);
  });
  showLastBackup();
  await loadOverview();
  return () => {
    page.seq += 1;
    page.root = null;
  };
}
