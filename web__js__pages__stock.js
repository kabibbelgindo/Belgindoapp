import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  emptyState, esc, fmtDate, fmtM3, fmtMoney, fmtQty, fmtSize,
  openDrawer, openForm, toast, todayISO,
} from "../ui.js";
import {
  downloadExport, locations, masters, pageHead,
} from "./common.js";

const state = {
  query: "",
  location: "",
  thickness: "",
  focusProduct: 0,
  rows: null,
  locked: null,
  autoOpened: false,
};

function layout() {
  const thicknessOptions = (masters().specs?.T || []).map((row) => row.value);
  return `${pageHead({
    eyebrow: "Gudang",
    title: "Persediaan",
    subtitle: "Posisi stok per barang dan ukuran, lalu telusuri lot asal untuk pengeluaran.",
    actions: `<button class="btn btn-secondary" type="button" data-export>${icon("download", 16)} Ekspor stok</button>
      <a class="btn btn-primary" href="#/outgoing">${icon("outgoing", 16)} Barang keluar</a>`,
  })}
  <form class="filters" id="stock-filters">
    <div class="field grow-field"><label class="field-label" for="stock-query">Cari</label><input class="input" id="stock-query" type="search" value="${esc(state.query)}" placeholder="Kode, nama, ukuran, lokasi…"></div>
    <div class="field"><label class="field-label" for="stock-location">Lokasi</label>
      <div class="select-wrap"><select class="input" id="stock-location"><option value="">Semua lokasi</option>
        ${locations().map((row) => `<option value="${esc(row.value)}" ${state.location === row.value ? "selected" : ""}>${esc(row.label)}</option>`).join("")}
      </select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="field"><label class="field-label" for="stock-thickness">Tebal</label>
      <div class="select-wrap"><select class="input" id="stock-thickness"><option value="">Semua tebal</option>
        ${thicknessOptions.map((value) => `<option value="${esc(value)}" ${String(state.thickness) === String(value) ? "selected" : ""}>${esc(value)} cm</option>`).join("")}
      </select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="filter-actions"><button class="btn btn-secondary" type="submit">${icon("search", 15)} Terapkan</button></div>
  </form>
  <div id="stock-focus"></div>
  <div class="card card-flush">
    <div class="card-header with-line stock-toolbar" style="padding-bottom:14px">
      <div><h2 style="font-size:15px;font-weight:650">Posisi persediaan</h2><p style="color:var(--muted);font-size:11px;margin-top:2px" id="stock-stamp">—</p></div>
      <div class="stock-totals" id="stock-totals"></div>
    </div>
    <div id="stock-table"><div class="loading-block"><span class="spinner"></span><span>Menghitung persediaan…</span></div></div>
  </div>`;
}

function focusBanner() {
  const holder = document.getElementById("stock-focus");
  if (!holder) return;
  if (!state.focusProduct) {
    holder.innerHTML = "";
    return;
  }
  const row = (state.rows || []).find((item) => Number(item.product_id) === Number(state.focusProduct));
  holder.innerHTML = `<div class="notice-line" style="margin-bottom:12px">${icon("filter", 15)}
    <span>Menampilkan ${row ? `${esc(row.code)} · ${esc(row.name)}` : "barang terpilih"} dari penerimaan impor.</span>
    <button class="btn btn-ghost btn-sm" type="button" data-clear-focus>Tampilkan semua</button>
  </div>`;
  holder.querySelector("[data-clear-focus]")?.addEventListener("click", () => {
    state.focusProduct = 0;
    location.hash = "#/stock";
  });
}

function visibleRows() {
  if (!state.rows) return [];
  if (!state.focusProduct) return state.rows;
  return state.rows.filter((row) => Number(row.product_id) === Number(state.focusProduct));
}

function renderTable() {
  const holder = document.getElementById("stock-table");
  if (!holder) return;
  if (!state.rows) {
    holder.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Menghitung persediaan…</span></div>`;
    return;
  }
  focusBanner();
  const rows = visibleRows();
  const totals = rows.reduce((acc, row) => {
    acc.qty += Number(row.stock || 0);
    acc.m3 += Number(row.m3 || 0);
    const locs = Object.values(row.locations || {}).filter((qty) => Number(qty) > 0).length;
    acc.locations += locs;
    return acc;
  }, { qty: 0, m3: 0, locations: 0 });
  const stamp = document.getElementById("stock-stamp");
  if (stamp) stamp.textContent = `Posisi per ${fmtDate(todayISO())} · ${fmtQty(rows.length)} baris barang/ukuran`;
  const totalsBox = document.getElementById("stock-totals");
  if (totalsBox) {
    totalsBox.innerHTML = `
      <span class="stock-total-item"><strong>${esc(fmtQty(rows.length))}</strong> kelompok</span>
      <span class="stock-total-item"><strong>${esc(fmtQty(totals.qty))}</strong> batang</span>
      <span class="stock-total-item"><strong>${esc(fmtM3(totals.m3))}</strong> m³</span>`;
  }
  if (!rows.length) {
    holder.innerHTML = emptyState({
      iconName: "package",
      title: "Tidak ada persediaan pada filter ini",
      text: state.focusProduct ? "Barang ini belum memiliki stok. Hapus filter untuk melihat seluruh gudang." : "Coba longgarkan filter atau catat penerimaan barang masuk terlebih dahulu.",
      action: state.focusProduct ? '<button class="btn btn-secondary btn-sm" type="button" data-clear-focus>Tampilkan semua</button>' : "",
    });
    holder.querySelector("[data-clear-focus]")?.addEventListener("click", () => {
      state.focusProduct = 0;
      location.hash = "#/stock";
    });
    return;
  }
  holder.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
    <th>Barang</th><th>Ukuran (T×L×P)</th><th>Sebaran lokasi</th><th class="num">Stok</th><th class="num">Volume</th><th></th>
  </tr></thead><tbody>
  ${rows.map((row) => `<tr class="is-clickable" data-product="${row.product_id}" data-size="${esc(row.size)}">
    <td><div class="cell-title">${esc(row.name)}</div><div class="cell-sub">${esc(row.code)} · ${esc(row.unit || "batang")}</div></td>
    <td><span class="size">${esc(row.size_display)}</span></td>
    <td><div class="pill-row">${Object.entries(row.locations || {}).filter(([, qty]) => Number(qty) > 0)
      .map(([loc, qty]) => `<span class="chip">${esc(loc || "Tanpa lokasi")} · ${esc(fmtQty(qty))}</span>`).join("") || '<span class="loc-empty">—</span>'}</div></td>
    <td class="num strong">${esc(fmtQty(row.stock))}</td>
    <td class="num">${esc(fmtM3(row.m3))}</td>
    <td><div class="row-actions"><button class="btn btn-ghost btn-sm" type="button" data-lot="${row.product_id}" data-size="${esc(row.size)}">${icon("layers", 14)} Lot</button></div></td>
  </tr>`).join("")}
  </tbody></table></div>
  <div class="table-footer"><span>Menampilkan <strong>${esc(fmtQty(rows.length))}</strong> baris</span><span>${esc(fmtM3(totals.m3))} m³ · ${esc(fmtQty(totals.qty))} batang</span></div>`;
}

async function loadRows() {
  state.rows = null;
  renderTable();
  try {
    const data = await api.get("/api/stock", {
      query: state.query,
      location: state.location,
      thickness: state.thickness,
    });
    state.rows = data.rows || [];
    state.locked = data.locked_through || null;
    renderTable();
    if (state.focusProduct && !state.autoOpened) {
      state.autoOpened = true;
      const row = state.rows.find((item) => Number(item.product_id) === Number(state.focusProduct));
      if (row) openLots(state.focusProduct, row.size);
    }
  } catch (error) {
    const holder = document.getElementById("stock-table");
    if (holder) holder.innerHTML = emptyState({ iconName: "alert", title: "Persediaan gagal dimuat", text: error.message });
  }
}

function pickLocation(row) {
  const entries = Object.entries(row.locations || {}).filter(([, qty]) => Number(qty) > 0);
  if (!entries.length) return "";
  if (state.location) return state.location;
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return entries[0][0];
}

async function openLots(productId, size, initialLocation = "") {
  const sourceRow = (state.rows || []).find((row) => Number(row.product_id) === Number(productId) && row.size === size)
    || (state.rows || []).find((row) => Number(row.product_id) === Number(productId)) || {};
  const locationCodes = Object.keys(sourceRow.locations || {});
  let location = initialLocation || pickLocation(sourceRow);
  const drawer = openDrawer({
    title: sourceRow.name || "Detail lot",
    eyebrow: "Telusur lot persediaan",
    size: "lg",
    iconName: "layers",
    body: `<div class="loading-block"><span class="spinner"></span><span>Memuat lot…</span></div>`,
  });

  const renderLots = async () => {
    drawer.bodyEl.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat lot…</span></div>`;
    let payload;
    try {
      payload = await api.get("/api/stock/lots", { product_id: productId, size, location });
    } catch (error) {
      drawer.bodyEl.innerHTML = `<div class="empty-state" style="padding:28px"><span class="empty-icon">${icon("alert", 24)}</span><strong>Lot gagal dimuat</strong><p>${esc(error.message)}</p></div>`;
      return;
    }
    const lots = payload.lots || [];
    drawer.bodyEl.innerHTML = `
      <div class="note-detail-head">
        <div class="note-copy">
          <div class="note-title-line"><strong>${esc(sourceRow.code || payload.product?.code || "")} · ${esc(payload.product?.name || sourceRow.name || "")}</strong><span class="size">${esc(fmtSize(size))}</span></div>
          <div class="note-sub">${esc(payload.product?.unit || "batang")} · lokasi ${esc(location || "tanpa lokasi")}</div>
        </div>
        <div class="note-amount"><span>Stok di lokasi</span><strong>${esc(fmtQty(payload.on_hand))}</strong></div>
      </div>
      ${locationCodes.length > 1 ? `<div class="field" style="max-width:240px;margin-top:14px"><label class="field-label" for="lot-location">Lokasi</label>
        <div class="select-wrap"><select class="input" id="lot-location">${locationCodes.map((code) => `<option value="${esc(code)}" ${code === location ? "selected" : ""}>${esc(code || "Tanpa lokasi")} · ${esc(fmtQty(sourceRow.locations?.[code] || 0))}</option>`).join("")}</select>${icon("chevronDown", 15, "select-chevron")}</div></div>` : ""}
      <div class="meta-grid">
        <div class="meta-cell"><span>Total lot aktif</span><strong>${esc(fmtQty(lots.length))}</strong></div>
        <div class="meta-cell"><span>Sisa dapat keluar</span><strong>${esc(fmtQty(lots.reduce((sum, lot) => sum + Number(lot.capacity || 0), 0)))}</strong></div>
        <div class="meta-cell"><span>Harga acuan</span><strong>${esc(fmtMoney(payload.product?.purchase_price))}/m³</strong></div>
        <div class="meta-cell"><span>Status periode</span><strong>${state.locked ? `Terkunci s.d. ${fmtDate(state.locked)}` : "Terbuka"}</strong></div>
      </div>
      <div class="lot-list" style="margin-top:16px">
        ${lots.length ? lots.map((lot) => {
          const ratio = Number(lot.qty) > 0 ? Math.min(100, Math.round((Number(lot.remaining) / Number(lot.qty)) * 100)) : 0;
          return `<div class="lot-card">
            <div class="lot-top">
              <div>
                <div class="lot-ref">${esc(lot.trx_number || `Lot #${lot.id}`)}</div>
                <div class="lot-date">${esc(fmtDate(lot.trx_date))}${lot.delivery_number ? ` · SJ ${esc(lot.delivery_number)}` : ""}</div>
              </div>
              <div class="lot-qty"><strong>${esc(fmtQty(lot.remaining))}</strong><span>dari ${esc(fmtQty(lot.qty))} batang</span></div>
            </div>
            <div class="lot-meta">
              <span><b>Supplier</b> ${esc(lot.supplier || "—")}</span>
              <span><b>Harga</b> ${esc(fmtMoney(lot.price))}/m³</span>
              <span><b>Sisa m³</b> ${esc(fmtM3(lot.m3_remaining))}</span>
              <span><b>Terpakai</b> ${esc(fmtQty(lot.used))}</span>
            </div>
            ${lot.note ? `<div class="lot-date" style="margin-top:6px">${esc(lot.note)}</div>` : ""}
            <div class="lot-bar"><span style="width:${ratio}%"></span></div>
            <div class="lot-foot">
              <small>Kapasitas keluar di lokasi ini: <strong>${esc(fmtQty(lot.capacity))}</strong></small>
              <button class="btn btn-secondary btn-sm" type="button" data-outgoing="${lot.id}" ${Number(lot.capacity) <= 0 ? "disabled" : ""}>${icon("outgoing", 14)} Keluarkan</button>
            </div>
          </div>`;
        }).join("") : `<div class="empty-state" style="padding:26px"><span class="empty-icon">${icon("layers", 24)}</span><strong>Tidak ada lot tersisa</strong><p>Seluruh lot pada lokasi ini sudah terpakai.</p></div>`}
      </div>`;
    const cardLink = drawer.footerEl?.querySelector("[data-lot-card]");
    if (cardLink) {
      cardLink.href = `#/stock-card?product=${productId}&size=${encodeURIComponent(size)}&location=${encodeURIComponent(location)}`;
    }
    drawer.bodyEl.querySelector("#lot-location")?.addEventListener("change", (event) => {
      location = event.target.value;
      renderLots();
    });
    drawer.bodyEl.querySelectorAll("[data-outgoing]").forEach((button) => {
      button.addEventListener("click", () => {
        const lot = lots.find((item) => Number(item.id) === Number(button.dataset.outgoing));
        if (lot) openOutgoingForm(lot, drawer, renderLots);
      });
    });
  };

  const footer = drawer.footerEl;
  if (footer) {
    footer.innerHTML = `<button class="btn btn-ghost" type="button" data-layer-close>Tutup</button>
      <a class="btn btn-secondary" href="#" data-lot-card>${icon("book", 15)} Kartu stok</a>
      <a class="btn btn-primary" href="#/outgoing" data-lot-outgoing>${icon("outgoing", 15)} Barang keluar</a>`;
    footer.querySelector("[data-lot-card]")?.addEventListener("click", () => drawer.close());
    footer.querySelector("[data-lot-outgoing]")?.addEventListener("click", () => drawer.close());
  }
  await renderLots();
}

function openOutgoingForm(lot, drawer, onDone) {
  const maxQty = Number(lot.capacity || 0);
  if (maxQty <= 0) {
    toast.warn("Lot ini tidak memiliki kapasitas keluar.");
    return;
  }
  openForm({
    title: "Barang keluar dari lot",
    eyebrow: "Pengeluaran stok",
    subtitle: `${lot.trx_number || `Lot #${lot.id}`} · ${fmtSize(lot.size)} · ${lot.location || "tanpa lokasi"}`,
    fields: [
      { name: "date", label: "Tanggal keluar", type: "date", required: true, value: todayISO(), max: todayISO(), min: String(lot.trx_date || "").slice(0, 10) },
      { name: "qty", label: "Qty keluar", type: "number", required: true, min: 0.0001, max: maxQty, step: "any", value: "", help: `Maksimum ${fmtQty(maxQty)} batang dari lot ini.` },
      { name: "note", label: "Catatan", type: "textarea", rows: 3, full: true, maxlength: 300, placeholder: "Tujuan pengeluaran, nomor dokumen, atau keterangan lain" },
    ],
    submitLabel: "Catat barang keluar",
    submitIcon: "outgoing",
    onSubmit: async (values) => {
      await api.post("/api/outgoing", {
        source_id: lot.id,
        location: lot.location || "",
        qty: values.qty,
        date: values.date,
        note: values.note || "",
      });
      toast.success(`${fmtQty(values.qty)} batang dicatat keluar.`);
      await loadRows();
      if (drawer) await onDone();
    },
  });
}

export async function render(root, { route } = {}) {
  state.query = route?.query?.get("query") || "";
  state.location = route?.query?.get("location") || "";
  state.thickness = route?.query?.get("thickness") || "";
  state.focusProduct = Number(route?.query?.get("product") || 0) || 0;
  state.autoOpened = false;
  root.innerHTML = layout();
  const form = root.querySelector("#stock-filters");
  const syncFromForm = () => {
    form.querySelector("#stock-query").value = state.query;
    form.querySelector("#stock-location").value = state.location;
    form.querySelector("#stock-thickness").value = state.thickness;
  };
  if (state.query || state.location || state.thickness) syncFromForm();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.query = form.querySelector("#stock-query").value.trim();
    state.location = form.querySelector("#stock-location").value;
    state.thickness = form.querySelector("#stock-thickness").value;
    state.focusProduct = 0;
    loadRows();
  });
  root.querySelector("[data-export]")?.addEventListener("click", (event) => {
    downloadExport("stock", {
      cutoff: todayISO(),
      query: state.query,
      location: state.location,
      thickness: state.thickness,
    }, "laporan-stok.xlsx", event.currentTarget).catch(() => {});
  });
  root.addEventListener("click", (event) => {
    const lotButton = event.target.closest("[data-lot]");
    if (lotButton) {
      event.stopPropagation();
      openLots(Number(lotButton.dataset.lot), lotButton.dataset.size);
      return;
    }
    const row = event.target.closest("tr[data-product]");
    if (row) openLots(Number(row.dataset.product), row.dataset.size);
  });
  await loadRows();
}
