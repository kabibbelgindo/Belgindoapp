import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  emptyState, esc, firstOfMonth, fmtDate, fmtM3, fmtMoney, fmtQty, statusBadge, toast, todayISO,
} from "../ui.js";
import {
  dateInput, downloadExport, locations, printHead, products, readForm,
  searchInput, selectField, sellers, specsFor,
} from "./common.js";
import { permissions } from "../state.js";

const BASE_TABS = [
  { key: "transactions", label: "Transaksi", icon: "history" },
  { key: "stock", label: "Persediaan", icon: "package" },
  { key: "sellers", label: "Penjual", icon: "users" },
  { key: "tallies", label: "Tally", icon: "clipboard" },
  { key: "recaps", label: "Rekap Bayar", icon: "wallet" },
  { key: "transfers", label: "Mutasi", icon: "transfer" },
  { key: "imports", label: "Impor", icon: "import" },
];

const EXPORT_NAMES = {
  transactions: "transactions",
  stock: "stock",
  sellers: "sellers",
  tallies: "tallies",
  recaps: "recaps",
  transfers: "transfers",
  imports: "imports",
  activity: "activity",
};

const state = {
  tab: "transactions",
  root: null,
  seq: 0,
  users: null,
  filters: {
    start: firstOfMonth(),
    end: todayISO(),
    kind: "MASUK",
    seller_id: "",
    product_id: "",
    location: "",
    cutoff: "",
    thickness: "",
    query: "",
    user_id: "",
  },
};

function tabs() {
  return permissions().activity
    ? [...BASE_TABS, { key: "activity", label: "Aktivitas", icon: "pulse" }]
    : BASE_TABS;
}

function tabInfo(key = state.tab) {
  return tabs().find((tab) => tab.key === key) || tabs()[0];
}

/* ------------------------------------------------------------------ filters */

function filterFields() {
  const f = state.filters;
  const tab = state.tab;
  const parts = [];

  if (tab === "stock") {
    parts.push(dateInput("cutoff", f.cutoff, { label: "Posisi per tanggal" }));
    parts.push(selectField("location", "Lokasi", locations(), f.location, { placeholder: "Semua lokasi" }));
    parts.push(selectField("thickness", "Tebal (mm)", specsFor("T"), f.thickness, { placeholder: "Semua tebal" }));
    parts.push(searchInput("query", f.query, { label: "Cari", placeholder: "Kode, barang, ukuran…" }));
    return parts.join("");
  }

  parts.push(dateInput("start", f.start, { label: "Dari tanggal" }));
  parts.push(dateInput("end", f.end, { label: "Sampai tanggal" }));

  if (tab === "transactions") {
    parts.push(selectField("kind", "Jenis", [
      { value: "MASUK", label: "Pembelian masuk" },
      { value: "KELUAR", label: "Pengeluaran" },
      { value: "OPNAME", label: "Penyesuaian opname" },
      { value: "SEMUA", label: "Semua transaksi" },
    ], f.kind));
    parts.push(selectField("seller_id", "Penjual", sellers(), f.seller_id, { placeholder: "Semua penjual" }));
    parts.push(selectField("product_id", "Barang", products(), f.product_id, { placeholder: "Semua barang" }));
    parts.push(selectField("location", "Lokasi", locations(), f.location, { placeholder: "Semua lokasi" }));
    parts.push(searchInput("query", f.query, { label: "Cari", placeholder: "Nota, surat jalan, barang…" }));
  } else if (tab === "sellers") {
    parts.push(`<div class="field grow-field"><label class="field-label">Catatan</label><div class="field-static">${icon("info", 14)} Rekap pembelian per penjual pada rentang tanggal.</div></div>`);
  } else if (tab === "tallies" || tab === "recaps") {
    parts.push(selectField("seller_id", "Penjual", sellers(), f.seller_id, { placeholder: "Semua penjual" }));
  } else if (tab === "transfers") {
    parts.push(searchInput("query", f.query, { label: "Cari", placeholder: "Barang, lokasi, catatan…" }));
  } else if (tab === "imports") {
    parts.push(searchInput("query", f.query, { label: "Cari", placeholder: "Dokumen, barcode, pemasok…" }));
  } else if (tab === "activity") {
    parts.push(selectField("user_id", "Pengguna", userOptions(), f.user_id, { placeholder: "Semua pengguna" }));
    parts.push(searchInput("query", f.query, { label: "Cari", placeholder: "Aksi atau rincian…" }));
  }
  return parts.join("");
}

function userOptions() {
  return (state.users || []).map((user) => ({
    value: user.id,
    label: user.full_name ? `${user.full_name} (@${user.username})` : `@${user.username}`,
  }));
}

async function ensureUsers() {
  if (state.users) return state.users;
  try {
    const data = await api.get("/api/master/users");
    state.users = data.users || [];
  } catch {
    state.users = [];
  }
  return state.users;
}

function bindFilters() {
  const form = state.root?.querySelector("#report-filter-form");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = readForm(form);
    Object.assign(state.filters, values);
    if (state.filters.start && state.filters.end && state.filters.start > state.filters.end) {
      toast.warn("Tanggal dari tidak boleh melewati tanggal sampai.");
      return;
    }
    loadReport();
  });
  form.querySelector("[data-reset-filters]")?.addEventListener("click", () => {
    state.filters.start = firstOfMonth();
    state.filters.end = todayISO();
    state.filters.kind = "MASUK";
    state.filters.seller_id = "";
    state.filters.product_id = "";
    state.filters.location = "";
    state.filters.cutoff = "";
    state.filters.thickness = "";
    state.filters.query = "";
    state.filters.user_id = "";
    renderFilters();
    loadReport();
  });
}

function renderFilters() {
  const holder = state.root?.querySelector("#report-filters");
  if (!holder) return;
  holder.innerHTML = `<form class="filters" id="report-filter-form" style="margin:0;border:0;box-shadow:none;background:transparent;padding:0">
    ${filterFields()}
    <div class="filter-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-reset-filters>${icon("rotate", 14)} Atur ulang</button>
      <button class="btn btn-primary btn-sm" type="submit">${icon("filter", 14)} Terapkan</button>
    </div>
  </form>`;
  bindFilters();
}

/* ------------------------------------------------------------------ request */

function queryParams(tab = state.tab) {
  const f = state.filters;
  const params = {};
  if (tab === "stock") {
    if (f.cutoff) params.cutoff = f.cutoff;
    if (f.location) params.location = f.location;
    if (f.thickness) params.thickness = f.thickness;
    if (f.query) params.query = f.query;
    return params;
  }
  if (f.start) params.start = f.start;
  if (f.end) params.end = f.end;
  if (tab === "transactions") {
    params.kind = f.kind || "MASUK";
    if (f.seller_id) params.seller_id = f.seller_id;
    if (f.product_id) params.product_id = f.product_id;
    if (f.location) params.location = f.location;
    if (f.query) params.query = f.query;
  } else if (tab === "tallies" || tab === "recaps") {
    if (f.seller_id) params.seller_id = f.seller_id;
  } else if (tab === "transfers" || tab === "imports" || tab === "activity") {
    if (f.query) params.query = f.query;
    if (tab === "activity" && f.user_id) params.user_id = f.user_id;
  }
  return params;
}

async function loadReport() {
  const body = state.root?.querySelector("#report-body");
  if (!body) return;
  const seq = ++state.seq;
  const tab = state.tab;
  body.innerHTML = `<div class="card"><div class="loading-block"><span class="spinner"></span><span>Menyusun laporan ${esc(tabInfo(tab).label.toLowerCase())}…</span></div></div>`;
  try {
    const data = await api.get(`/api/reports/${tab}`, queryParams(tab));
    if (seq !== state.seq) return;
    const rendered = RENDERERS[tab] ? RENDERERS[tab](data) : errorBlock("Laporan tidak dikenal.");
    body.innerHTML = rendered;
    bindReportActions(body);
  } catch (error) {
    if (seq !== state.seq) return;
    body.innerHTML = `<div class="card card-pad">${emptyState({
      iconName: "alert",
      title: "Laporan gagal dimuat",
      text: error.message,
      action: '<button class="btn btn-secondary" type="button" data-retry-report>Muat ulang</button>',
    })}</div>`;
    body.querySelector("[data-retry-report]")?.addEventListener("click", loadReport);
  }
}

function bindReportActions(root) {
  root.querySelectorAll("[data-pdf-tally]").forEach((button) => {
    button.addEventListener("click", () => api.openPdf(`/api/pdf/tally/${button.dataset.pdfTally}`));
  });
  root.querySelectorAll("[data-pdf-recap]").forEach((button) => {
    button.addEventListener("click", () => api.openPdf(`/api/pdf/recap/${button.dataset.pdfRecap}`));
  });
}

/* ------------------------------------------------------------------ partials */

function errorBlock(message) {
  return `<div class="card card-pad">${emptyState({ iconName: "alert", title: "Laporan tidak tersedia", text: message })}</div>`;
}

function summaryItem(label, value, { total = false } = {}) {
  return `<div class="report-summary-item${total ? " total" : ""}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

function periodBlock(period, label = "Periode laporan") {
  return `<div class="report-period"><span>${esc(label)}</span><strong>${esc(period)}</strong></div>`;
}

function summary(period, items) {
  return `<div class="report-summary">
    ${items.map((item) => summaryItem(item.label, item.value, { total: item.total })).join("")}
    ${periodBlock(period)}
  </div>`;
}

function table({ columns, rows, footer = "", className = "report-table", headTitle = "", headSub = "" }) {
  return `<div class="card card-flush">
    ${headTitle ? `<div class="card-header with-line" style="padding-bottom:12px"><div class="section-head" style="margin:0"><div><h2 style="font-size:13px">${esc(headTitle)}</h2>${headSub ? `<p>${esc(headSub)}</p>` : ""}</div></div></div>` : ""}
    <div class="table-wrap"><table class="table ${className}">
      <thead><tr>${columns.map((column) => `<th class="${column.num ? "num" : ""}">${esc(column.label)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
      ${footer ? `<tfoot>${footer}</tfoot>` : ""}
    </table></div>
  </div>`;
}

function emptyRows(colspan, title = "Tidak ada data pada rentang ini", text = "Ubah filter tanggal atau kata kunci untuk melihat data lain.") {
  return `<tr><td colspan="${colspan}" style="padding:0"><div class="empty-state" style="padding:38px 18px"><span class="empty-icon">${icon("chart", 24)}</span><strong>${esc(title)}</strong><p>${esc(text)}</p></div></td></tr>`;
}

function sellerCell(name, city = "") {
  return `<div class="cell-title">${esc(name || "—")}</div>${city ? `<div class="cell-sub">${esc(city)}</div>` : ""}`;
}

function productCell(row) {
  return `<div class="cell-title">${esc(row.name || "—")}</div><div class="cell-sub">${esc(row.code || "")}</div>`;
}

function totalRow(cells) {
  return `<tr class="tfoot-totals">${cells.map((cell, index) => `<td class="${index === 0 ? "" : "num"}">${cell}</td>`).join("")}</tr>`;
}

function printBlock(title, period) {
  return printHead(title, period);
}

/* ------------------------------------------------------------------ renderers */

const RENDERERS = {
  transactions(data) {
    const kindLabels = { MASUK: "Pembelian masuk", KELUAR: "Pengeluaran", OPNAME: "Penyesuaian opname", SEMUA: "Semua transaksi" };
    const period = `${data.start_display} — ${data.end_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td class="cell-sub">${esc(row.date_display)}</td>
          <td><span class="ref">${esc(row.reference || "—")}</span>${row.delivery_number ? `<div class="cell-sub">SJ ${esc(row.delivery_number)}</div>` : ""}</td>
          <td>${sellerCell(row.seller_name, row.rit_number_display !== "-" ? `Rit ${row.rit_number_display}` : "")}</td>
          <td>${productCell(row)}</td>
          <td>${esc(row.size_display)}</td>
          <td class="cell-sub">${esc(row.location || "—")}</td>
          <td class="num">${esc(fmtQty(row.qty))}</td>
          <td class="num">${esc(fmtM3(row.m3))}</td>
          <td class="num">${esc(fmtMoney(row.price))}</td>
          <td class="num"><strong>${esc(fmtMoney(row.amount))}</strong></td>
        </tr>`).join("")
      : emptyRows(10);
    return `${printBlock(`Laporan Transaksi ${kindLabels[data.kind] || data.kind}`, period)}
      ${summary(period, [
        { label: "Baris transaksi", value: esc(fmtQty(data.totals.count)) },
        { label: "Jumlah batang", value: esc(fmtQty(data.totals.qty)) },
        { label: "Volume", value: `${esc(fmtM3(data.totals.m3))} m³` },
        { label: "Nilai", value: esc(fmtMoney(data.totals.amount)), total: true },
      ])}
      ${table({
        columns: [
          { label: "Tanggal" }, { label: "Nota / referensi" }, { label: "Penjual" },
          { label: "Barang" }, { label: "Ukuran T×L×P" }, { label: "Lokasi" },
          { label: "Qty", num: true }, { label: "M³", num: true },
          { label: "Harga/m³", num: true }, { label: "Jumlah", num: true },
        ],
        rows,
        footer: data.rows.length ? totalRow([
          "TOTAL", "", "", "", "", "",
          esc(fmtQty(data.totals.qty)), esc(fmtM3(data.totals.m3)), "",
          esc(fmtMoney(data.totals.amount)),
        ]) : "",
      })}`;
  },

  stock(data) {
    const period = `Posisi ${data.cutoff_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td>${productCell(row)}</td>
          <td>${esc(row.size_display)}</td>
          <td class="cell-sub">${esc(row.location || "Tanpa lokasi")}</td>
          <td class="num">${esc(fmtQty(row.stock))}</td>
          <td class="num">${esc(fmtM3(row.m3))}</td>
          <td class="num">${esc(fmtMoney(row.price))}</td>
          <td class="num"><strong>${esc(fmtMoney(row.value))}</strong></td>
        </tr>`).join("")
      : emptyRows(7);
    return `${printBlock("Laporan Persediaan", period)}
      ${summary(period, [
        { label: "Baris stok", value: esc(fmtQty(data.totals.lots)) },
        { label: "Jumlah batang", value: esc(fmtQty(data.totals.qty)) },
        { label: "Volume", value: `${esc(fmtM3(data.totals.m3))} m³` },
        { label: "Nilai persediaan", value: esc(fmtMoney(data.totals.value)), total: true },
      ])}
      ${table({
        columns: [
          { label: "Barang" }, { label: "Ukuran T×L×P" }, { label: "Lokasi" },
          { label: "Qty", num: true }, { label: "M³", num: true },
          { label: "Harga acuan/m³", num: true }, { label: "Nilai", num: true },
        ],
        rows,
        footer: data.rows.length ? totalRow([
          "TOTAL", "", "", esc(fmtQty(data.totals.qty)), esc(fmtM3(data.totals.m3)), "",
          esc(fmtMoney(data.totals.value)),
        ]) : "",
      })}`;
  },

  sellers(data) {
    const period = `${data.start_display} — ${data.end_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td>${sellerCell(row.seller_name, row.city)}</td>
          <td class="num">${esc(fmtQty(row.rits))}</td>
          <td class="num">${esc(fmtQty(row.notes))}</td>
          <td class="num">${esc(fmtQty(row.lines))}</td>
          <td class="num">${esc(fmtQty(row.qty))}</td>
          <td class="num">${esc(fmtM3(row.m3))}</td>
          <td class="num"><strong>${esc(fmtMoney(row.amount))}</strong></td>
        </tr>`).join("")
      : emptyRows(7);
    return `${printBlock("Rekap Pembelian per Penjual", period)}
      ${summary(period, [
        { label: "Penjual aktif bertransaksi", value: esc(fmtQty(data.totals.sellers)) },
        { label: "Jumlah batang", value: esc(fmtQty(data.totals.qty)) },
        { label: "Volume", value: `${esc(fmtM3(data.totals.m3))} m³` },
        { label: "Nilai pembelian", value: esc(fmtMoney(data.totals.amount)), total: true },
      ])}
      ${table({
        columns: [
          { label: "Penjual" }, { label: "Rit", num: true }, { label: "Nota", num: true },
          { label: "Baris", num: true }, { label: "Qty", num: true },
          { label: "M³", num: true }, { label: "Nilai", num: true },
        ],
        rows,
        footer: data.rows.length ? totalRow([
          "TOTAL", "", "", "", esc(fmtQty(data.totals.qty)),
          esc(fmtM3(data.totals.m3)), esc(fmtMoney(data.totals.amount)),
        ]) : "",
      })}`;
  },

  tallies(data) {
    const period = `${data.start_display} — ${data.end_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td><span class="ref">${esc(row.tally_number)}</span></td>
          <td class="cell-sub">${esc(row.created_display)}</td>
          <td>${sellerCell(row.seller_name)}</td>
          <td class="num">${esc(row.rit_number_display || "—")}</td>
          <td class="num">${esc(fmtQty(row.total_qty))}</td>
          <td class="num">${esc(fmtM3(row.total_volume))}</td>
          <td class="num"><strong>${esc(fmtMoney(row.total_amount))}</strong></td>
          <td>${esc(row.signature || "—")}</td>
          <td>${statusBadge(row.status)}</td>
          <td class="row-actions"><button class="icon-btn" type="button" title="Buka PDF tally" data-pdf-tally="${row.id}">${icon("printer", 15)}</button></td>
        </tr>`).join("")
      : emptyRows(10);
    return `${printBlock("Daftar Tally", period)}
      ${summary(period, [
        { label: "Tally tercatat", value: esc(fmtQty(data.totals.count)) },
        { label: "Volume diperiksa", value: `${esc(fmtM3(data.totals.volume))} m³` },
        { label: "Nilai tally", value: esc(fmtMoney(data.totals.amount)), total: true },
      ])}
      ${table({
        columns: [
          { label: "Nomor tally" }, { label: "Dibuat" }, { label: "Penjual" },
          { label: "Rit", num: true }, { label: "Qty", num: true }, { label: "M³", num: true },
          { label: "Nilai", num: true }, { label: "Pemeriksa" }, { label: "Status" }, { label: "" },
        ],
        rows,
        footer: data.rows.length ? totalRow([
          "TOTAL", "", "", "", esc(fmtQty(data.rows.reduce((sum, row) => sum + Number(row.total_qty || 0), 0))),
          esc(fmtM3(data.totals.volume)), esc(fmtMoney(data.totals.amount)), "", "", "",
        ]) : "",
      })}`;
  },

  recaps(data) {
    const period = `${data.start_display} — ${data.end_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td><span class="ref">${esc(row.recap_number)}</span></td>
          <td class="cell-sub">${esc(row.created_display || "—")}</td>
          <td>${sellerCell(row.seller_name)}</td>
          <td class="num">${esc(row.rit_number_display || "—")}</td>
          <td class="num">${esc(fmtQty(row.total_qty))}</td>
          <td class="num">${esc(fmtM3(row.total_volume))}</td>
          <td class="num"><strong>${esc(fmtMoney(row.total_amount))}</strong></td>
          <td>${statusBadge(row.status)}</td>
          <td class="row-actions"><button class="icon-btn" type="button" title="Buka PDF rekap" data-pdf-recap="${row.id}">${icon("printer", 15)}</button></td>
        </tr>`).join("")
      : emptyRows(9);
    return `${printBlock("Rekap Pembayaran", period)}
      ${summary(period, [
        { label: "Rekap tercatat", value: esc(fmtQty(data.totals.count)) },
        { label: "Nilai rekap", value: esc(fmtMoney(data.totals.amount)), total: true },
      ])}
      ${table({
        columns: [
          { label: "Nomor rekap" }, { label: "Tanggal" }, { label: "Penjual" },
          { label: "Rit", num: true }, { label: "Qty", num: true }, { label: "M³", num: true },
          { label: "Nilai", num: true }, { label: "Status" }, { label: "" },
        ],
        rows,
        footer: data.rows.length ? totalRow([
          "TOTAL", "", "", "", "", "", esc(fmtMoney(data.totals.amount)), "", "",
        ]) : "",
      })}`;
  },

  transfers(data) {
    const period = `${data.start_display} — ${data.end_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td class="cell-sub">${esc(fmtDate(row.transfer_date))}</td>
          <td>${productCell(row)}</td>
          <td>${esc(row.size_display)}</td>
          <td><span class="loc">${esc(row.from_location || "—")} ${icon("arrowRight", 12)} ${esc(row.to_location || "—")}</span></td>
          <td class="num">${esc(fmtQty(row.qty))}</td>
          <td class="num">${esc(fmtM3(row.m3))}</td>
          <td class="cell-sub">${esc(row.username || "—")}</td>
          <td class="cell-sub">${esc(row.note || "—")}</td>
        </tr>`).join("")
      : emptyRows(8);
    return `${printBlock("Mutasi Antar Lokasi", period)}
      ${summary(period, [
        { label: "Perpindahan", value: esc(fmtQty(data.totals.count)) },
        { label: "Jumlah batang", value: esc(fmtQty(data.totals.qty)) },
        { label: "Volume berpindah", value: `${esc(fmtM3(data.totals.m3))} m³`, total: true },
      ])}
      ${table({
        columns: [
          { label: "Tanggal" }, { label: "Barang" }, { label: "Ukuran T×L×P" },
          { label: "Dari → ke" }, { label: "Qty", num: true }, { label: "M³", num: true },
          { label: "Petugas" }, { label: "Catatan" },
        ],
        rows,
        footer: data.rows.length ? totalRow([
          "TOTAL", "", "", "", esc(fmtQty(data.totals.qty)), esc(fmtM3(data.totals.m3)), "", "",
        ]) : "",
      })}`;
  },

  imports(data) {
    const period = `${data.start_display} — ${data.end_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td class="cell-sub">${esc(row.date_display)}</td>
          <td><span class="ref">${esc(row.trx_number)}</span>${row.document_number ? `<div class="cell-sub">${esc(row.document_number)}</div>` : ""}</td>
          <td>${productCell(row)}</td>
          <td>${esc(row.size_display)}</td>
          <td class="num">${esc(fmtQty(row.qty))}</td>
          <td class="num">${esc(fmtM3(row.m3))}</td>
          <td class="num">${esc(fmtMoney(row.price))}</td>
          <td class="num"><strong>${esc(fmtMoney(row.amount))}</strong></td>
          <td class="cell-sub">${esc(row.supplier || "—")}</td>
          <td class="cell-sub">${esc(row.location || "—")}</td>
        </tr>`).join("")
      : emptyRows(10);
    return `${printBlock("Penerimaan Kayu Impor", period)}
      ${summary(period, [
        { label: "Penerimaan", value: esc(fmtQty(data.totals.count)) },
        { label: "Jumlah batang", value: esc(fmtQty(data.totals.qty)) },
        { label: "Volume", value: `${esc(fmtM3(data.totals.m3))} m³` },
        { label: "Nilai", value: esc(fmtMoney(data.totals.amount)), total: true },
      ])}
      ${table({
        columns: [
          { label: "Tanggal" }, { label: "Penerimaan / dokumen" }, { label: "Barang" },
          { label: "Ukuran T×L×P" }, { label: "Qty", num: true }, { label: "M³", num: true },
          { label: "Harga/m³", num: true }, { label: "Jumlah", num: true },
          { label: "Pemasok" }, { label: "Lokasi" },
        ],
        rows,
        footer: data.rows.length ? totalRow([
          "TOTAL", "", "", "", esc(fmtQty(data.totals.qty)), esc(fmtM3(data.totals.m3)), "",
          esc(fmtMoney(data.totals.amount)), "", "",
        ]) : "",
      })}`;
  },

  activity(data) {
    const period = `${data.start_display} — ${data.end_display}`;
    const rows = data.rows.length
      ? data.rows.map((row) => `<tr>
          <td class="cell-sub" style="white-space:nowrap">${esc(row.time_display)}</td>
          <td><span class="user-handle">@${esc(row.username)}</span></td>
          <td><span class="action-tag">${esc(row.action)}</span></td>
          <td style="max-width:520px;word-break:break-word">${esc(row.detail || "—")}</td>
        </tr>`).join("")
      : emptyRows(4, "Belum ada aktivitas", "Log aktivitas pada rentang tanggal ini masih kosong.");
    return `${printBlock("Log Aktivitas Pengguna", period)}
      ${summary(period, [
        { label: "Baris log", value: esc(fmtQty(data.rows.length)) },
        { label: "Pengguna tercatat", value: esc(fmtQty(new Set(data.rows.map((row) => row.username)).size)) },
      ])}
      ${table({
        className: "activity-table",
        headTitle: "Jejak audit",
        headSub: "Setiap aksi penting tercatat dan tidak dapat diubah dari antarmuka.",
        columns: [{ label: "Waktu" }, { label: "Pengguna" }, { label: "Aksi" }, { label: "Rincian" }],
        rows,
      })}`;
  },
};

/* ------------------------------------------------------------------ shell */

function tabsHTML() {
  return tabs().map((tab) => `<button class="tab${tab.key === state.tab ? " is-active" : ""}" type="button" data-report-tab="${tab.key}">
    ${icon(tab.icon, 14)} ${esc(tab.label)}
  </button>`).join("");
}

function pageHeadHTML() {
  return `<div class="page-head">
    <div>
      <span class="eyebrow">${icon("chart", 13)} Analitik &amp; arsip</span>
      <h1>Laporan &amp; Ekspor</h1>
      <p>Delapan sudut pandang atas aliran kayu — dari nota penerimaan hingga saldo persediaan. Setiap laporan dapat dicetak atau diunduh sebagai Excel.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary" type="button" data-print-report>${icon("printer", 16)} Cetak</button>
      <button class="btn btn-primary" type="button" data-export-report>${icon("download", 16)} Ekspor Excel</button>
    </div>
  </div>`;
}

async function exportCurrent(button) {
  const params = queryParams();
  const fallback = `laporan-${state.tab}-${state.filters.end || todayISO()}.xlsx`;
  await downloadExport(EXPORT_NAMES[state.tab], params, fallback, button);
}

function bindShell() {
  state.root.querySelectorAll("[data-report-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      const key = button.dataset.reportTab;
      if (key === state.tab) return;
      state.tab = key;
      state.root.querySelectorAll("[data-report-tab]").forEach((tabButton) => {
        tabButton.classList.toggle("is-active", tabButton.dataset.reportTab === key);
      });
      const url = `#/reports?tab=${encodeURIComponent(key)}`;
      if (location.hash !== url) history.replaceState(null, "", url);
      if (key === "activity") await ensureUsers();
      renderFilters();
      loadReport();
    });
  });
  state.root.querySelector("[data-print-report]")?.addEventListener("click", () => window.print());
  state.root.querySelector("[data-export-report]")?.addEventListener("click", (event) => {
    exportCurrent(event.currentTarget).catch(() => {});
  });
}

export async function render(root, { route } = {}) {
  state.root = root;
  const requested = route?.query?.get("tab");
  if (requested && tabs().some((tab) => tab.key === requested)) state.tab = requested;
  if (!tabs().some((tab) => tab.key === state.tab)) state.tab = "transactions";
  if (route?.query?.get("start")) state.filters.start = route.query.get("start");
  if (route?.query?.get("end")) state.filters.end = route.query.get("end");

  if (state.tab === "activity" && permissions().activity) {
    await ensureUsers();
  }

  root.innerHTML = `${pageHeadHTML()}
    <section class="report-tabs-card no-print">
      <div class="tabs" role="tablist">${tabsHTML()}</div>
      <div class="report-filters" id="report-filters"></div>
    </section>
    <div id="report-body"></div>`;
  bindShell();
  renderFilters();
  await loadReport();
  return () => {
    state.seq += 1;
    state.root = null;
  };
}
