import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  esc, firstOfMonth, fmtDate, fmtDateTime, fmtM3, fmtMoney, fmtQty,
  openDrawer, statusBadge, toast, todayISO,
} from "../ui.js";
import {
  downloadExport, pageHead, promptReason, refreshAllMeta, sellers,
} from "./common.js";

const state = {
  start: firstOfMonth(),
  end: todayISO(),
  sellerId: "",
  status: "",
  query: "",
  rows: null,
};

function layout() {
  return `${pageHead({
    eyebrow: "Penerimaan",
    title: "Rekap Pembayaran",
    subtitle: "Kunci nota yang sudah diperiksa menjadi dokumen pembayaran penjual.",
    actions: `<button class="btn btn-secondary" type="button" data-export>${icon("download", 16)} Ekspor Excel</button>`,
  })}
  <form class="filters" id="recap-filters">
    <div class="field"><label class="field-label" for="recap-start">Dari</label><input class="input" id="recap-start" type="date" value="${esc(state.start)}"></div>
    <div class="field"><label class="field-label" for="recap-end">Sampai</label><input class="input" id="recap-end" type="date" value="${esc(state.end)}"></div>
    <div class="field"><label class="field-label" for="recap-seller">Penjual</label>
      <div class="select-wrap"><select class="input" id="recap-seller">
        <option value="">Semua penjual</option>
        ${sellers().map((row) => `<option value="${esc(row.value)}" ${String(state.sellerId) === String(row.value) ? "selected" : ""}>${esc(row.label)}</option>`).join("")}
      </select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="field"><label class="field-label" for="recap-status">Status</label>
      <div class="select-wrap"><select class="input" id="recap-status">
        <option value="" ${state.status === "" ? "selected" : ""}>Semua status</option>
        <option value="AKTIF" ${state.status === "AKTIF" ? "selected" : ""}>Aktif</option>
        <option value="BATAL" ${state.status === "BATAL" ? "selected" : ""}>Dibatalkan</option>
      </select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="field grow-field"><label class="field-label" for="recap-query">Cari</label><input class="input" id="recap-query" type="search" value="${esc(state.query)}" placeholder="Nomor rekap, nota, penjual…"></div>
    <div class="filter-actions">
      <button class="btn btn-ghost" type="button" data-reset>${icon("rotate", 15)} Reset</button>
      <button class="btn btn-secondary" type="submit">${icon("search", 15)} Terapkan</button>
    </div>
  </form>
  <div class="card card-flush">
    <div class="card-header with-line stock-toolbar" style="padding-bottom:14px">
      <div><h2 style="font-size:15px;font-weight:650">Daftar rekap pembayaran</h2><p style="color:var(--muted);font-size:11px;margin-top:2px" id="recap-range">—</p></div>
      <div class="stock-totals" id="recap-totals"></div>
    </div>
    <div id="recap-table"><div class="loading-block"><span class="spinner"></span><span>Memuat rekap…</span></div></div>
  </div>`;
}

function activeTotals(rows) {
  return rows.reduce((acc, row) => {
    if (row.status !== "AKTIF") return acc;
    acc.count += 1;
    acc.qty += Number(row.total_qty || 0);
    acc.m3 += Number(row.total_volume || 0);
    acc.amount += Number(row.total_amount || 0);
    return acc;
  }, { count: 0, qty: 0, m3: 0, amount: 0 });
}

function renderTable() {
  const holder = document.getElementById("recap-table");
  if (!holder) return;
  if (!state.rows) {
    holder.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat rekap…</span></div>`;
    return;
  }
  const range = document.getElementById("recap-range");
  if (range) range.textContent = `${fmtDate(state.start)} — ${fmtDate(state.end)}`;
  const totals = activeTotals(state.rows);
  const totalsBox = document.getElementById("recap-totals");
  if (totalsBox) {
    totalsBox.innerHTML = `
      <span class="stock-total-item"><strong>${esc(fmtQty(totals.count))}</strong> rekap aktif</span>
      <span class="stock-total-item"><strong>${esc(fmtQty(totals.qty))}</strong> batang</span>
      <span class="stock-total-item"><strong>${esc(fmtM3(totals.m3))}</strong> m³</span>
      <span class="stock-total-item"><strong>${esc(fmtMoney(totals.amount))}</strong></span>`;
  }
  if (!state.rows.length) {
    holder.innerHTML = `<div class="empty-state" style="padding:40px 18px"><span class="empty-icon">${icon("receipt", 26)}</span><strong>Belum ada rekap pembayaran</strong><p>Rekap dibuat dari halaman Penerimaan setelah nota selesai ditally.</p><div class="empty-action"><a class="btn btn-secondary btn-sm" href="#/receiving">${icon("arrowRight", 15)} Ke Penerimaan</a></div></div>`;
    return;
  }
  holder.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
    <th>Rekap</th><th>Penjual</th><th>Rit / Nota</th><th class="num">Baris</th><th class="num">Qty</th><th class="num">m³</th><th class="num">Nilai</th><th>Status</th><th></th>
  </tr></thead><tbody>
  ${state.rows.map((row) => `<tr class="is-clickable" data-recap-id="${row.id}">
    <td><div class="cell-title">${esc(row.recap_number)}</div><div class="cell-sub">${esc(fmtDate(row.created_at))}</div></td>
    <td><div class="cell-title">${esc(row.seller_name || "—")}</div><div class="cell-sub">oleh ${esc(row.username || "—")}</div></td>
    <td><div class="cell-title">Rit ${esc(row.rit_number_display || "-")}</div><div class="cell-sub">Nota ${esc(row.note || "—")}</div></td>
    <td class="num">${esc(fmtQty(row.item_count))}</td>
    <td class="num">${esc(fmtQty(row.total_qty))}</td>
    <td class="num">${esc(fmtM3(row.total_volume))}</td>
    <td class="num strong">${esc(fmtMoney(row.total_amount))}</td>
    <td>${statusBadge(row.status)}</td>
    <td><div class="row-actions"><button class="icon-btn" type="button" data-recap-id="${row.id}" title="Detail rekap">${icon("eye", 15)}</button></div></td>
  </tr>`).join("")}
  </tbody></table></div>
  <div class="table-footer"><span>Menampilkan <strong>${esc(fmtQty(state.rows.length))}</strong> dokumen</span><span>Total aktif ${esc(fmtMoney(totals.amount))}</span></div>`;
}

async function loadRows() {
  state.rows = null;
  renderTable();
  try {
    const data = await api.get("/api/recaps", {
      start: state.start,
      end: state.end,
      seller_id: state.sellerId,
      status: state.status,
      query: state.query,
    });
    state.rows = data.recaps || [];
    renderTable();
  } catch (error) {
    const holder = document.getElementById("recap-table");
    if (holder) holder.innerHTML = `<div class="empty-state" style="padding:34px"><span class="empty-icon">${icon("alert", 24)}</span><strong>Rekap gagal dimuat</strong><p>${esc(error.message)}</p></div>`;
  }
}

async function openDetail(recapId) {
  const drawer = openDrawer({
    title: "Detail rekap pembayaran",
    eyebrow: "Dokumen pembayaran",
    size: "lg",
    iconName: "receipt",
    body: `<div class="loading-block"><span class="spinner"></span><span>Memuat rekap…</span></div>`,
  });
  let header;
  try {
    header = await api.get(`/api/recaps/${recapId}`);
  } catch (error) {
    drawer.bodyEl.innerHTML = `<div class="empty-state" style="padding:28px"><span class="empty-icon">${icon("alert", 24)}</span><strong>Rekap gagal dimuat</strong><p>${esc(error.message)}</p></div>`;
    return;
  }
  const items = header.items || [];
  drawer.bodyEl.innerHTML = `
    <div class="note-detail-head">
      <div class="note-copy">
        <div class="note-title-line"><strong>${esc(header.recap_number)}</strong>${statusBadge(header.status)}</div>
        <div class="note-sub">${esc(header.seller_name || "—")} · Rit ${esc(header.rit_number_display || "-")} · Nota ${esc(header.note || "—")}</div>
      </div>
      <div class="note-amount"><span>Total pembayaran</span><strong>${esc(fmtMoney(header.total_amount))}</strong></div>
    </div>
    <div class="meta-grid">
      <div class="meta-cell"><span>Dibuat</span><strong>${esc(fmtDateTime(header.created_at))}</strong></div>
      <div class="meta-cell"><span>Petugas</span><strong>${esc(header.username || "—")}</strong></div>
      <div class="meta-cell"><span>Tanggal rit</span><strong>${esc(fmtDate(header.rit_date))}</strong></div>
      <div class="meta-cell"><span>Jumlah baris</span><strong>${esc(fmtQty(items.length))}</strong></div>
    </div>
    ${items.length ? `<div class="note-table"><div class="table-wrap"><table class="table"><thead><tr>
      <th>Barang</th><th>Ukuran (T×L×P)</th><th class="num">Qty</th><th class="num">m³</th><th class="num">Harga/m³</th><th class="num">Jumlah</th>
    </tr></thead><tbody>
    ${items.map((item) => `<tr>
      <td><div class="cell-title">${esc(item.name)}</div><div class="cell-sub">${esc(item.code)} · ${esc(item.trx_number || "")}</div></td>
      <td><span class="size">${esc(item.size_display || "-")}</span></td>
      <td class="num">${esc(fmtQty(item.qty))}</td>
      <td class="num">${esc(fmtM3(item.volume))}</td>
      <td class="num">${esc(fmtMoney(item.price))}</td>
      <td class="num strong">${esc(fmtMoney(item.amount))}</td>
    </tr>`).join("")}
    </tbody></table></div></div>` : `<div class="empty-state" style="padding:26px"><strong>Belum ada baris</strong></div>`}
    <div class="tally-total-card">
      <div><span>Total qty</span><br><strong>${esc(fmtQty(header.total_qty))} batang</strong></div>
      <div><span>Total volume</span><br><strong>${esc(fmtM3(header.total_volume))} m³</strong></div>
      <div><span>Total nilai</span><br><strong>${esc(fmtMoney(header.total_amount))}</strong></div>
    </div>
    ${header.cancel_note ? `<div class="notice-line" style="margin-top:12px">${icon("info", 14)} Alasan batal: ${esc(header.cancel_note)}</div>` : ""}`;
  const footer = drawer.footerEl;
  if (!footer) return;
  footer.innerHTML = `<button class="btn btn-ghost" type="button" data-layer-close>Tutup</button>
    <button class="btn btn-secondary" type="button" data-pdf>${icon("printer", 16)} Cetak rekap</button>
    ${header.can_cancel ? `<button class="btn btn-danger" type="button" data-cancel>${icon("x", 16)} Batalkan rekap</button>` : ""}`;
  footer.querySelector("[data-pdf]")?.addEventListener("click", () => api.openPdf(`/api/pdf/recap/${header.id}`));
  footer.querySelector("[data-cancel]")?.addEventListener("click", async () => {
    const values = await promptReason({
      title: `Batalkan ${header.recap_number}?`,
      message: "Rekap pembayaran akan dibatalkan dan baris nota dapat direkap kembali.",
      confirmLabel: "Batalkan rekap",
    });
    if (!values) return;
    try {
      await api.post(`/api/recaps/${header.id}/cancel`, { reason: values.reason || "" });
      toast.success("Rekap pembayaran dibatalkan.");
      drawer.close();
      await loadRows();
      refreshAllMeta().catch(() => {});
    } catch (error) {
      toast.error(error.message);
    }
  });
}

export async function render(root, { route } = {}) {
  root.innerHTML = layout();
  const form = root.querySelector("#recap-filters");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.start = form.querySelector("#recap-start").value || state.start;
    state.end = form.querySelector("#recap-end").value || state.end;
    state.sellerId = form.querySelector("#recap-seller").value;
    state.status = form.querySelector("#recap-status").value;
    state.query = form.querySelector("#recap-query").value.trim();
    loadRows();
  });
  form.querySelector("[data-reset]")?.addEventListener("click", () => {
    state.start = firstOfMonth();
    state.end = todayISO();
    state.sellerId = "";
    state.status = "";
    state.query = "";
    form.querySelector("#recap-start").value = state.start;
    form.querySelector("#recap-end").value = state.end;
    form.querySelector("#recap-seller").value = "";
    form.querySelector("#recap-status").value = "";
    form.querySelector("#recap-query").value = "";
    loadRows();
  });
  root.querySelector("[data-export]")?.addEventListener("click", (event) => {
    downloadExport("recaps", {
      start: state.start,
      end: state.end,
      seller_id: state.sellerId,
    }, "rekap-pembayaran.xlsx", event.currentTarget).catch(() => {});
  });
  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-recap-id]");
    if (!target || !root.contains(target)) return;
    openDetail(target.dataset.recapId);
  });
  await loadRows();
  const preset = route?.query?.get("id");
  if (preset) openDetail(preset);
}
