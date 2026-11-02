/* Lapisan API edisi Firebase: antarmuka modul sama persis dengan edisi lokal
   (api.get/post/put/del/download/openPdf), tetapi permintaan dieksekusi langsung
   oleh mesin data Firestore di browser — tanpa server Python. */

import { AppError } from "./store/core.js";
import { createEngine, createMemoryBackend } from "./store/engine.js";
import { createFirestoreBackend, probeFirestore } from "./store/firestore-backend.js";
import { createApp } from "./store/handlers.js";
import { firebaseConfig } from "./firebase-config.js";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "ERROR" } = {}) {
    super(message || "Terjadi kesalahan.");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = "br_fb_token";

const storageAdapter = {
  read(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value ?? null));
    } catch {
      /* penyimpanan penuh: sesi tetap berjalan di memori */
    }
  },
};

/* Mode memori (?store=memory): data hanya hidup di tab ini — dipakai untuk
   demo tanpa jaringan dan pengujian antarmuka tanpa menyentuh Firestore. */
const memoryOnly = new URLSearchParams(location.search).get("store") === "memory";

function pickBackend() {
  if (memoryOnly) return Promise.resolve(createMemoryBackend());
  return createFirestoreBackend(firebaseConfig);
}

const backendPromise = pickBackend()
  .then((backend) => createEngine(backend))
  .then((engine) => createApp(engine, { storage: storageAdapter }))
  .catch((error) => {
    bootError = error;
    throw error;
  });

let bootError = null;

/* Kesehatan koneksi Firestore (REST probe): dipakai layar penyiapan agar
   pengguna melihat petunjuk perbaikan sebelum mencoba login. */
export async function firestoreHealth() {
  if (memoryOnly) return { ok: true, kind: "MEMORY", projectId: "(mode memori)" };
  return probeFirestore(firebaseConfig);
}

function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof AppError) {
    return new ApiError(error.message, { status: error.status, code: error.code });
  }
  return new ApiError(error?.message || "Terjadi kesalahan internal.", { status: 500, code: "INTERNAL_ERROR" });
}

function token() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function sessionProblem(status) {
  if (status === 401) {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* abaikan */ }
    window.dispatchEvent(new CustomEvent("br:session-expired"));
  }
}

async function call(method, path, { body, params, quietAuth = false } = {}) {
  let app;
  try {
    app = await backendPromise;
  } catch (error) {
    throw new ApiError(
      error?.message || "Tidak dapat terhubung ke Firebase. Periksa koneksi lalu muat ulang halaman.",
      { status: 0, code: "NETWORK" },
    );
  }
  const query = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry !== undefined && entry !== null && entry !== "") query[key] = entry;
        }
      } else {
        query[key] = value;
      }
    }
  }
  const [pathname, queryPart] = String(path).split("?");
  if (queryPart && !Object.keys(query).length) {
    for (const [key, value] of new URLSearchParams(queryPart).entries()) query[key] = value;
  }
  try {
    const result = await app.dispatch({
      method,
      path: pathname,
      query,
      body: body === undefined ? null : body,
      token: token(),
      ip: "browser",
    });
    if (result?.token) {
      try { localStorage.setItem(TOKEN_KEY, result.token); } catch { /* abaikan */ }
    }
    return result?.data ?? null;
  } catch (error) {
    const apiError = toApiError(error);
    if (!quietAuth) sessionProblem(apiError.status);
    throw apiError;
  }
}

function buildQuery(params) {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null && entry !== "") search.append(key, entry);
      }
    } else {
      search.append(key, value);
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function saveBlob(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function download(path, params, fallbackName = "unduhan") {
  try {
    const data = await call("GET", path, { params });
    const payload = data && typeof data === "object" && data.__download__ ? data.__download__ : null;
    if (!payload) throw new ApiError("Berkas tidak dapat disiapkan.", { code: "DOWNLOAD" });
    saveBlob(payload.content, payload.filename, payload.mime);
    return payload.filename;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Tidak dapat mengunduh berkas. Periksa koneksi.", { code: "NETWORK" });
  }
}

/* ------------------------------------------------------------------ cetak */

function printDocument(title, bodyHtml) {
  const win = window.open("", "_blank", "width=1024,height=768");
  if (!win) {
    throw new ApiError("Popup diblokir browser. Izinkan popup untuk mencetak dokumen.", { code: "POPUP" });
  }
  win.document.write(`<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 10pt/1.45 "Segoe UI", Arial, sans-serif; color: #10202b; margin: 24px; }
  h1 { font-size: 14pt; margin: 0 0 2px; color: #0c2f26; }
  h2 { font-size: 11.5pt; margin: 14px 0 6px; }
  .meta { color: #526477; font-size: 8.5pt; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; }
  th, td { border: 1px solid #b9c6d0; padding: 4px 6px; font-size: 8.5pt; vertical-align: top; }
  th { background: #0c2f26; color: #fff; text-align: left; }
  tr:nth-child(even) td { background: #f2f6f4; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .sign { margin-top: 26px; display: flex; gap: 48px; }
  .sign div { flex: 1; border-top: 1px solid #333; padding-top: 4px; font-size: 8.5pt; text-align: center; }
  footer { margin-top: 18px; color: #7a8a96; font-size: 7.5pt; }
  @page { size: A4; margin: 14mm; }
  @media print { body { margin: 0; } .noprint { display: none; } }
</style></head><body>
${bodyHtml}
<footer>Dicetak dari PT. Belgindo Raya Inventory · ${new Date().toLocaleString("id-ID")}</footer>
<script>window.onload = function () { window.focus(); window.print(); };<\/script>
</body></html>`);
  win.document.close();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value) {
  const amount = Number(value || 0);
  return `Rp ${Math.round(amount).toLocaleString("id-ID")}`;
}

function qty(value) {
  return String(value ?? "").replace(".", ",");
}

function openPdf(path, params) {
  const match = /\/api\/pdf\/(tally|recap|opname)\/(\d+)/.exec(path);
  if (!match) return;
  const [, kind, id] = match;
  const mode = params?.mode || "count";
  if (kind === "tally") {
    call("GET", `/api/tallies/${id}`).then((tally) => {
      const rows = (tally.items || []).map((item, index) => `<tr>
        <td>${index + 1}</td><td>${escapeHtml(item.code || "")}</td><td>${escapeHtml(item.name || "")}</td>
        <td>${escapeHtml(item.size_display || "-")}</td><td>${escapeHtml(item.trx_number || "-")}</td>
        <td>${escapeHtml(item.kind || "")}</td><td class="num">${qty(item.qty_display)}</td>
        <td class="num">${qty(item.volume)}</td><td class="num">${item.kind === "AFKIR" ? "-" : money(item.price_m3)}</td>
        <td class="num">${money(item.amount)}</td><td>${escapeHtml(item.note || "")}</td></tr>`).join("");
      printDocument(`Tally ${tally.tally_number}`, `
        <h1>PT. BELGINDO RAYA INVENTORY</h1>
        <div class="meta">Dokumen Tally · ${escapeHtml(tally.tally_number)} · Status ${escapeHtml(tally.status)}</div>
        <table>
          <tr><th>Penjual</th><td>${escapeHtml(tally.seller_name || "-")}</td><th>Rit</th><td>${escapeHtml(tally.rit_number_display || "-")}</td></tr>
          <tr><th>Nota</th><td>${escapeHtml(tally.note || "-")}</td><th>Surat Jalan</th><td>${escapeHtml(tally.delivery_number || "-")}</td></tr>
          <tr><th>Dibuat</th><td>${escapeHtml(String(tally.created_at || "").slice(0, 10))}</td><th>Pemeriksa</th><td>${escapeHtml(tally.signature || "-")}</td></tr>
        </table>
        <h2>Rincian barang</h2>
        <table><thead><tr><th>No</th><th>Kode</th><th>Barang</th><th>Ukuran</th><th>Nota</th><th>Kategori</th>
        <th>Qty</th><th>m³</th><th>Harga/m³</th><th>Jumlah</th><th>Catatan</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <table style="margin-top:8px">
          <tr><th>Total Qty</th><td class="num">${qty(tally.total_qty)}</td><th>Total m³</th><td class="num">${qty(tally.total_volume)}</td><th>Total Nilai</th><td class="num">${money(tally.total_amount)}</td></tr>
        </table>
        <div class="sign"><div>Pemeriksa</div><div>Penerima</div></div>`);
    }).catch((error) => window.alert(error.message || "Cetak gagal."));
    return;
  }
  if (kind === "recap") {
    call("GET", `/api/recaps/${id}`).then((recap) => {
      const rows = (recap.items || []).map((item, index) => `<tr>
        <td>${index + 1}</td><td>${escapeHtml(item.trx_number || "-")}</td><td>${escapeHtml(item.code || "")}</td>
        <td>${escapeHtml(item.name || "")}</td><td>${escapeHtml(item.size_display || "-")}</td>
        <td class="num">${qty(item.qty_display)}</td><td class="num">${qty(item.volume)}</td>
        <td class="num">${money(item.price)}</td><td class="num">${money(item.amount)}</td></tr>`).join("");
      printDocument(`Rekap ${recap.recap_number}`, `
        <h1>PT. BELGINDO RAYA INVENTORY</h1>
        <div class="meta">Rekap Pembayaran · ${escapeHtml(recap.recap_number)} · Status ${escapeHtml(recap.status)}</div>
        <table>
          <tr><th>Penjual</th><td>${escapeHtml(recap.seller_name || "-")}</td><th>Rit / Nota</th><td>${escapeHtml(recap.rit_number_display || "-")} / ${escapeHtml(recap.note || "-")}</td></tr>
          <tr><th>Dibuat</th><td>${escapeHtml(String(recap.created_at || "").slice(0, 10))}</td><th>Petugas</th><td>${escapeHtml(recap.username || "-")}</td></tr>
        </table>
        <h2>Rincian</h2>
        <table><thead><tr><th>No</th><th>Nota</th><th>Kode</th><th>Barang</th><th>Ukuran</th>
        <th>Qty</th><th>m³</th><th>Harga/m³</th><th>Jumlah</th></tr></thead><tbody>${rows}</tbody></table>
        <table style="margin-top:8px">
          <tr><th>Total Qty</th><td class="num">${qty(recap.total_qty)}</td><th>Total m³</th><td class="num">${qty(recap.total_volume)}</td><th>Total Nilai</th><td class="num">${money(recap.total_amount)}</td></tr>
        </table>
        <div class="sign"><div>Hormat kami</div><div>Penerima Pembayaran</div></div>`);
    }).catch((error) => window.alert(error.message || "Cetak gagal."));
    return;
  }
  call("GET", `/api/opname/${id}`).then((session) => {
    const countMode = mode !== "result";
    const rows = (session.items || []).map((item, index) => countMode ? `<tr>
        <td>${index + 1}</td><td>${escapeHtml(item.code || "")}</td><td>${escapeHtml(item.name || "")}</td>
        <td>${escapeHtml(item.size_display || "-")}</td><td>${escapeHtml(item.location || "-")}</td>
        <td class="num">${qty(item.system_display)}</td><td></td><td></td></tr>`
      : `<tr>
        <td>${index + 1}</td><td>${escapeHtml(item.code || "")}</td><td>${escapeHtml(item.name || "")}</td>
        <td>${escapeHtml(item.size_display || "-")}</td><td>${escapeHtml(item.location || "-")}</td>
        <td class="num">${qty(item.system_display)}</td><td class="num">${item.counted ? qty(item.physical_qty) : "-"}</td>
        <td class="num">${item.diff === null || item.diff === undefined ? "-" : qty(item.diff)}</td>
        <td>${escapeHtml(item.reason || "")}</td><td>${escapeHtml(item.note || "")}</td></tr>`).join("");
    const head = countMode
      ? "<tr><th>No</th><th>Kode</th><th>Barang</th><th>Ukuran</th><th>Lokasi</th><th>Stok Sistem</th><th>Stok Fisik</th><th>Catatan</th></tr>"
      : "<tr><th>No</th><th>Kode</th><th>Barang</th><th>Ukuran</th><th>Lokasi</th><th>Sistem</th><th>Fisik</th><th>Selisih</th><th>Alasan</th><th>Catatan</th></tr>";
    printDocument(`Stok Opname #${session.id}`, `
      <h1>PT. BELGINDO RAYA INVENTORY</h1>
      <div class="meta">Lembar ${countMode ? "Penghitungan" : "Hasil Opname"} · Periode ${escapeHtml(session.period_start_display)} s.d. ${escapeHtml(session.period_end_display)} · ${escapeHtml(session.label_status)}</div>
      <table><thead>${head}</thead><tbody>${rows}</tbody></table>`);
  }).catch((error) => window.alert(error.message || "Cetak gagal."));
}

export const api = {
  get: (path, params) => call("GET", path, { params }),
  post: (path, body, options = {}) => call("POST", path, { body, ...options }),
  put: (path, body, options = {}) => call("PUT", path, { body, ...options }),
  del: (path, body, options = {}) => call("DELETE", path, { body, ...options }),
  request: (path, options = {}) => call(options.method || "GET", path, options),
  download,
  openPdf,
  buildQuery,
};
