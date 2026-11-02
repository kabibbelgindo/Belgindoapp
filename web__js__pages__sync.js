import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  badge, confirmDialog, emptyState, esc, fmtDateTime, fmtQty, toast,
} from "../ui.js";
import { loadingCard } from "./common.js";
import { permissions } from "../state.js";

const state = {
  root: null,
  data: null,
  seq: 0,
};

function renderPanel() {
  const holder = state.root?.querySelector("#sync-body");
  if (!holder) return;
  const data = state.data;
  if (!data) return;
  const pending = Number(data.pending || 0);
  const failed = Number(data.failed || 0);
  const synced = Number(data.synced || 0);
  const total = Number(data.total || 0);
  const healthy = pending === 0;
  holder.innerHTML = `
    <div class="system-grid">
      <div class="stack">
        <div class="card"><div class="card-pad">
          <div class="section-head" style="margin-bottom:6px">
            <div><span class="eyebrow">Status penyimpanan</span><h2 style="font-size:17px;margin-top:4px">${esc(data.mode_label || "Database lokal")}</h2></div>
            ${badge(healthy ? "Sehat" : "Perlu pemeriksaan", healthy ? "green" : "amber", !healthy)}
          </div>
          <div class="sync-status" style="margin-top:10px">
            <div class="status-line"><span class="sync-pulse ${healthy ? "" : "warn"}"></span> ${healthy ? "Semua perubahan tercatat" : `${esc(fmtQty(pending))} perubahan menunggu`}</div>
            <p class="field-help" style="margin-top:6px">${esc(data.message || "")}</p>
          </div>
          <div class="sync-counters">
            <div class="sync-counter"><span>Menunggu</span><strong>${esc(fmtQty(pending))}</strong></div>
            <div class="sync-counter"><span>Gagal</span><strong>${esc(fmtQty(failed))}</strong></div>
            <div class="sync-counter"><span>Tersinkron</span><strong>${esc(fmtQty(synced))}</strong></div>
          </div>
          <div class="hero-actions">
            <button class="btn btn-primary" type="button" data-sync-retry ${pending ? "" : "disabled"}>${icon("refresh", 15)} Tandai tersinkron</button>
            <button class="btn btn-secondary" type="button" data-sync-refresh>${icon("rotate", 15)} Periksa ulang</button>
            ${permissions().is_primary ? `<button class="btn btn-ghost" type="button" data-sync-purge ${synced ? "" : "disabled"}>${icon("trash", 15)} Bersihkan baris tersinkron</button>` : ""}
          </div>
        </div></div>
        <div class="card card-flush">
          <div class="card-header with-line" style="padding-bottom:12px"><div class="section-head" style="margin:0"><div><h2 style="font-size:13px">Rincian outbox</h2><p>Antrean audit lokal untuk setiap perubahan data.</p></div></div></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Keterangan</th><th class="num">Nilai</th></tr></thead>
            <tbody>
              <tr><td class="cell-title">Total baris outbox</td><td class="num">${esc(fmtQty(total))}</td></tr>
              <tr><td class="cell-title">Menunggu / gagal</td><td class="num">${esc(fmtQty(pending))}</td></tr>
              <tr><td class="cell-title">Sudah ditandai tersinkron</td><td class="num">${esc(fmtQty(synced))}</td></tr>
              <tr><td class="cell-title">Peristiwa terakhir</td><td class="num">${data.last ? esc(fmtDateTime(data.last.created_at)) : "—"}</td></tr>
              <tr><td class="cell-title">Entitas terakhir</td><td class="num">${data.last ? esc(`${data.last.entity || "—"} · ${data.last.action || "—"}`) : "—"}</td></tr>
            </tbody>
          </table></div>
        </div>
      </div>
      <aside class="stack">
        <div class="card"><div class="card-pad">
          <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Cara kerja</h2></div></div>
          <ol class="hint-list">
            <li>Setiap perubahan transaksi dan master dicatat ke outbox lokal.</li>
            <li>PT. Belgindo Raya Inventory berjalan di atas Firebase Firestore (paket Spark).</li>
            <li>“Tandai tersinkron” menutup antrean yang sudah diperiksa.</li>
            <li>Pembersihan hanya menghapus baris yang berstatus tersinkron.</li>
          </ol>
        </div></div>
        <div class="card"><div class="card-pad">
          <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Kapan memakai</h2></div></div>
          <p class="field-help">Gunakan “Tandai tersinkron” setelah pemeriksaan manual atau pemulihan. Bila terjadi kegagalan berulang, unduh backup terlebih dahulu sebelum membersihkan outbox.</p>
          <div class="section-divider"></div>
          <div class="notice-line">${icon("shield", 15)} <span>Pembersihan outbox khusus Admin Utama.</span></div>
        </div></div>
      </aside>
    </div>`;
  bindPanel();
}

function bindPanel() {
  const holder = state.root?.querySelector("#sync-body");
  holder?.querySelector("[data-sync-retry]")?.addEventListener("click", retrySync);
  holder?.querySelector("[data-sync-refresh]")?.addEventListener("click", loadSync);
  holder?.querySelector("[data-sync-purge]")?.addEventListener("click", purgeSync);
}

async function loadSync() {
  const holder = state.root?.querySelector("#sync-body");
  if (!holder) return;
  const seq = ++state.seq;
  if (!state.data) holder.innerHTML = loadingCard("Memeriksa outbox…");
  try {
    const data = await api.get("/api/admin/sync");
    if (seq !== state.seq) return;
    state.data = data;
    renderPanel();
  } catch (error) {
    if (seq !== state.seq) return;
    holder.innerHTML = `<div class="card card-pad">${emptyState({
      iconName: "alert", title: "Status sinkronisasi gagal dimuat", text: error.message,
      action: '<button class="btn btn-secondary" type="button" data-retry-sync>Muat ulang</button>',
    })}</div>`;
    holder.querySelector("[data-retry-sync]")?.addEventListener("click", loadSync);
  }
}

async function retrySync() {
  const result = await confirmDialog({
    title: "Tandai semua perubahan tersinkron?",
    message: "Seluruh baris PENDING dan FAILED akan ditandai SYNCED. Gunakan setelah antrean diperiksa; tindakan ini tercatat pada log aktivitas.",
    confirmLabel: "Tandai tersinkron",
    iconName: "refresh",
  });
  if (!result.confirmed) return;
  try {
    const data = await api.post("/api/admin/sync/retry", {});
    toast.success(`${data.updated} baris ditandai tersinkron.`);
    state.data = data.status || state.data;
    renderPanel();
  } catch (error) {
    toast.error(error.message);
  }
}

async function purgeSync() {
  const result = await confirmDialog({
    title: "Bersihkan outbox tersinkron?",
    message: "Baris yang sudah berstatus SYNCED akan dihapus permanen dari outbox. Riwayat transaksi dan log aktivitas tidak terpengaruh.",
    confirmLabel: "Bersihkan",
    danger: true,
    iconName: "trash",
  });
  if (!result.confirmed) return;
  try {
    const data = await api.post("/api/admin/sync/purge", {});
    toast.success(`${data.deleted} baris outbox dihapus.`);
    await loadSync();
  } catch (error) {
    toast.error(error.message);
  }
}

export async function render(root) {
  state.root = root;
  state.data = null;
  state.seq += 1;
  root.innerHTML = `<div class="page-head">
    <div>
      <span class="eyebrow">${icon("refresh", 13)} Administrasi data</span>
      <h1>Sinkronisasi</h1>
      <p>PT. Belgindo Raya Inventory menyimpan seluruh data di Firestore. Halaman ini memperlihatkan antrean outbox yang mencatat setiap perubahan penting dan menyediakan pemeriksaan manual.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary" type="button" data-sync-refresh-top>${icon("rotate", 16)} Periksa ulang</button>
    </div>
  </div>
  <div id="sync-body"></div>`;
  root.querySelector("[data-sync-refresh-top]")?.addEventListener("click", loadSync);
  await loadSync();
  return () => {
    state.seq += 1;
    state.root = null;
  };
}
