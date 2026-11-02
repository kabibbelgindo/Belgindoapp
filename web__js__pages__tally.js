import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  badge, esc, firstOfMonth, fmtDate, fmtDateTime, fmtM3, fmtMoney, fmtQty,
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
    title: "Tally & Pemeriksaan",
    subtitle: "Catatan pemeriksaan fisik baris nota: qty fresh, afkir, dan tanda tangan pemeriksa.",
    actions: `<button class="btn btn-secondary" type="button" data-export>${icon("download", 16)} Ekspor Excel</button>`,
  })}
  <form class="filters" id="tally-filters">
    <div class="field"><label class="field-label" for="tally-start">Dari</label><input class="input" id="tally-start" type="date" value="${esc(state.start)}"></div>
    <div class="field"><label class="field-label" for="tally-end">Sampai</label><input class="input" id="tally-end" type="date" value="${esc(state.end)}"></div>
    <div class="field"><label class="field-label" for="tally-seller">Penjual</label>
      <div class="select-wrap"><select class="input" id="tally-seller">
        <option value="">Semua penjual</option>
        ${sellers().map((row) => `<option value="${esc(row.value)}" ${String(state.sellerId) === String(row.value) ? "selected" : ""}>${esc(row.label)}</option>`).join("")}
      </select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="field"><label class="field-label" for="tally-status">Status</label>
      <div class="select-wrap"><select class="input" id="tally-status">
        <option value="" ${state.status === "" ? "selected" : ""}>Semua status</option>
        <option value="POSTED" ${state.status === "POSTED" ? "selected" : ""}>Aktif</option>
        <option value="BATAL" ${state.status === "BATAL" ? "selected" : ""}>Dibatalkan</option>
      </select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="field grow-field"><label class="field-label" for="tally-query">Cari</label><input class="input" id="tally-query" type="search" value="${esc(state.query)}" placeholder="Nomor tally, nota, penjual, pemeriksa…"></div>
    <div class="filter-actions">
      <button class="btn btn-ghost" type="button" data-reset>${icon("rotate", 15)} Reset</button>
      <button class="btn btn-secondary" type="submit">${icon("search", 15)} Terapkan</button>
    </div>
  </form>
  <div class="card card-flush">
    <div class="card-header with-line stock-toolbar" style="padding-bottom:14px">
      <div><h2 style="font-size:15px;font-weight:650">Daftar tally</h2><p style="color:var(--muted);font-size:11px;margin-top:2px" id="tally-range">—</p></div>
      <div class="stock-totals" id="tally-totals"></div>
    </div>
    <div id="tally-table"><div class="loading-block"><span class="spinner"></span><span>Memuat tally…</span></div></div>
  </div>`;
}

function activeTotals(rows) {
  return rows.reduce((acc, row) => {
    if (row.status !== "POSTED") return acc;
    acc.count += 1;
    acc.qty += Number(row.total_qty || 0);
    acc.m3 += Number(row.total_volume || 0);
    acc.amount += Number(row.total_amount || 0);
    return acc;
  }, { count: 0, qty: 0, m3: 0, amount: 0 });
}

function renderTable() {
  const holder = document.getElementById("tally-table");
  if (!holder) return;
  if (!state.rows) {
    holder.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat tally…</span></div>`;
    return;
  }
  const range = document.getElementById("tally-range");
  const totalsBox = document.getElementById("tally-totals");
  if (range) range.textContent = `${fmtDate(state.start)} — ${fmtDate(state.end)}`;
  const totals = activeTotals(state.rows);
  if (totalsBox) {
    totalsBox.innerHTML = `
      <span class="stock-total-item"><strong>${esc(fmtQty(totals.count))}</strong> tally aktif</span>
      <span class="stock-total-item"><strong>${esc(fmtQty(totals.qty))}</strong> batang</span>
      <span class="stock-total-item"><strong>${esc(fmtM3(totals.m3))}</strong> m³</span>
      <span class="stock-total-item"><strong>${esc(fmtMoney(totals.amount))}</strong></span>`;
  }
  if (!state.rows.length) {
    holder.innerHTML = `<div class="empty-state" style="padding:40px 18px"><span class="empty-icon">${icon("tally", 26)}</span><strong>Belum ada tally pada filter ini</strong><p>Tally dibuat dari halaman Penerimaan saat nota diperiksa.</p><div class="empty-action"><a class="btn btn-secondary btn-sm" href="#/receiving">${icon("arrowRight", 15)} Ke Penerimaan</a></div></div>`;
    return;
  }
  holder.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
    <th>Tally</th><th>Penjual</th><th>Rit / Nota</th><th class="num">Baris</th><th class="num">Qty</th><th class="num">m³</th><th class="num">Nilai</th><th>Pemeriksa</th><th>Status</th><th></th>
  </tr></thead><tbody>
  ${state.rows.map((row) => `<tr class="is-clickable" data-tally-id="${row.id}">
    <td><div class="cell-title">${esc(row.tally_number)}</div><div class="cell-sub">${esc(row.created_display || fmtDate(row.created_at))}</div></td>
    <td><div class="cell-title">${esc(row.seller_name || "—")}</div><div class="cell-sub">oleh ${esc(row.username || "—")}</div></td>
    <td><div class="cell-title">Rit ${esc(row.rit_number_display || "-")}</div><div class="cell-sub">Nota ${esc(row.note || "—")}</div></td>
    <td class="num">${esc(fmtQty(row.item_count))}</td>
    <td class="num">${esc(fmtQty(row.total_qty))}</td>
    <td class="num">${esc(fmtM3(row.total_volume))}</td>
    <td class="num strong">${esc(fmtMoney(row.total_amount))}</td>
    <td>${esc(row.signature || "—")}</td>
    <td>${statusBadge(row.status)}</td>
    <td><div class="row-actions"><button class="icon-btn" type="button" data-tally-id="${row.id}" title="Detail tally">${icon("eye", 15)}</button></div></td>
  </tr>`).join("")}
  </tbody></table></div>
  <div class="table-footer"><span>Menampilkan <strong>${esc(fmtQty(state.rows.length))}</strong> dokumen</span><span>Total aktif ${esc(fmtM3(totals.m3))} m³ · ${esc(fmtMoney(totals.amount))}</span></div>`;
}

async function loadRows() {
  state.rows = null;
  renderTable();
  try {
    const data = await api.get("/api/tallies", {
      start: state.start,
      end: state.end,
      seller_id: state.sellerId,
      status: state.status,
      query: state.query,
    });
    state.rows = data.tallies || [];
    renderTable();
  } catch (error) {
    const holder = document.getElementById("tally-table");
    if (holder) holder.innerHTML = `<div class="empty-state" style="padding:34px"><span class="empty-icon">${icon("alert", 24)}</span><strong>Tally gagal dimuat</strong><p>${esc(error.message)}</p></div>`;
  }
}

async function openDetail(tallyId) {
  const drawer = openDrawer({
    title: "Detail tally",
    eyebrow: "Dokumen pemeriksaan",
    size: "lg",
    iconName: "tally",
    body: `<div class="loading-block"><span class="spinner"></span><span>Memuat tally…</span></div>`,
  });
  let header;
  try {
    header = await api.get(`/api/tallies/${tallyId}`);
  } catch (error) {
    drawer.bodyEl.innerHTML = `<div class="empty-state" style="padding:28px"><span class="empty-icon">${icon("alert", 24)}</span><strong>Tally gagal dimuat</strong><p>${esc(error.message)}</p></div>`;
    return;
  }
  const items = header.items || [];
  drawer.bodyEl.innerHTML = `
    <div class="note-detail-head">
      <div class="note-copy">
        <div class="note-title-line"><strong>${esc(header.tally_number)}</strong>${statusBadge(header.status)}</div>
        <div class="note-sub">${esc(header.seller_name || "—")} · Rit ${esc(header.rit_number_display || "-")} · Nota ${esc(header.note || "—")}</div>
      </div>
      <div class="note-amount"><span>Nilai tally</span><strong>${esc(fmtMoney(header.total_amount))}</strong></div>
    </div>
    <div class="meta-grid">
      <div class="meta-cell"><span>Dibuat</span><strong>${esc(fmtDateTime(header.created_at))}</strong></div>
      <div class="meta-cell"><span>Petugas</span><strong>${esc(header.username || "—")}</strong></div>
      <div class="meta-cell"><span>Pemeriksa</span><strong>${esc(header.signature || "—")}</strong></div>
      <div class="meta-cell"><span>Surat jalan</span><strong>${esc(header.rit_delivery || "—")}</strong></div>
    </div>
    ${items.length ? `<div class="note-table"><div class="table-wrap"><table class="table"><thead><tr>
      <th>Barang</th><th>Ukuran (T×L×P)</th><th>Jenis</th><th class="num">Qty</th><th class="num">m³</th><th class="num">Harga/m³</th><th class="num">Jumlah</th>
    </tr></thead><tbody>
    ${items.map((item) => `<tr>
      <td><div class="cell-title">${esc(item.name)}</div><div class="cell-sub">${esc(item.code)}${item.trx_note ? ` · ${esc(item.trx_note)}` : ""}</div></td>
      <td><span class="size">${esc(item.size_display || "-")}</span></td>
      <td>${badge(item.kind === "AFKIR" ? "Afkir" : "Fresh", item.kind === "AFKIR" ? "amber" : "green")}</td>
      <td class="num">${esc(fmtQty(item.qty))}</td>
      <td class="num">${esc(fmtM3(item.volume))}</td>
      <td class="num">${esc(fmtMoney(item.price_m3))}</td>
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
    <button class="btn btn-secondary" type="button" data-pdf>${icon("printer", 16)} Cetak slip</button>
    ${header.can_cancel ? `<button class="btn btn-danger" type="button" data-cancel>${icon("x", 16)} Batalkan tally</button>` : ""}`;
  footer.querySelector("[data-pdf]")?.addEventListener("click", () => api.openPdf(`/api/pdf/tally/${header.id}`));
  footer.querySelector("[data-cancel]")?.addEventListener("click", async () => {
    const values = await promptReason({
      title: `Batalkan ${header.tally_number}?`,
      message: "Tally akan berstatus batal dan baris nota dapat ditally kembali.",
      confirmLabel: "Batalkan tally",
    });
    if (!values) return;
    try {
      await api.post(`/api/tallies/${header.id}/cancel`, { reason: values.reason || "" });
      toast.success("Tally dibatalkan.");
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
  const form = root.querySelector("#tally-filters");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.start = form.querySelector("#tally-start").value || state.start;
    state.end = form.querySelector("#tally-end").value || state.end;
    state.sellerId = form.querySelector("#tally-seller").value;
    state.status = form.querySelector("#tally-status").value;
    state.query = form.querySelector("#tally-query").value.trim();
    loadRows();
  });
  form.querySelector("[data-reset]")?.addEventListener("click", () => {
    state.start = firstOfMonth();
    state.end = todayISO();
    state.sellerId = "";
    state.status = "";
    state.query = "";
    form.querySelector("#tally-start").value = state.start;
    form.querySelector("#tally-end").value = state.end;
    form.querySelector("#tally-seller").value = "";
    form.querySelector("#tally-status").value = "";
    form.querySelector("#tally-query").value = "";
    loadRows();
  });
  root.querySelector("[data-export]")?.addEventListener("click", (event) => {
    downloadExport("tallies", {
      start: state.start,
      end: state.end,
      seller_id: state.sellerId,
    }, "daftar-tally.xlsx", event.currentTarget).catch(() => {});
  });
  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-tally-id]");
    if (!target || !root.contains(target)) return;
    openDetail(target.dataset.tallyId);
  });
  await loadRows();
  const preset = route?.query?.get("id");
  if (preset) openDetail(preset);
}
