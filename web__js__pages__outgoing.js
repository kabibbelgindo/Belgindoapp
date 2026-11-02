import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  badge, emptyState, esc, firstOfMonth, fmtDate, fmtDateTime, fmtM3, fmtMoney, fmtQty,
  openDrawer, openForm, toast, todayISO,
} from "../ui.js";
import {
  downloadExport, locations, pageHead, promptReason, refreshAllMeta,
} from "./common.js";

const state = {
  start: firstOfMonth(),
  end: todayISO(),
  query: "",
  rows: null,
  selected: new Set(),
};

function layout() {
  return `${pageHead({
    eyebrow: "Gudang",
    title: "Barang Keluar",
    subtitle: "Keluarkan stok dari lot masuk tertentu agar sisa dan kapasitas selalu terlacak.",
    actions: `<button class="btn btn-secondary" type="button" data-export>${icon("download", 16)} Ekspor Excel</button>
      <button class="btn btn-primary" type="button" data-create>${icon("plus", 16)} Barang keluar</button>`,
  })}
  <form class="filters" id="outgoing-filters">
    <div class="field"><label class="field-label" for="out-start">Dari</label><input class="input" id="out-start" type="date" value="${esc(state.start)}"></div>
    <div class="field"><label class="field-label" for="out-end">Sampai</label><input class="input" id="out-end" type="date" value="${esc(state.end)}"></div>
    <div class="field grow-field"><label class="field-label" for="out-query">Cari</label><input class="input" id="out-query" type="search" value="${esc(state.query)}" placeholder="Barang, ukuran, lokasi, catatan, pemasok…"></div>
    <div class="filter-actions"><button class="btn btn-secondary" type="submit">${icon("search", 15)} Terapkan</button></div>
  </form>
  <div class="card card-flush">
    <div class="card-header with-line stock-toolbar" style="padding-bottom:14px">
      <div><h2 style="font-size:15px;font-weight:650">Riwayat barang keluar</h2><p style="color:var(--muted);font-size:11px;margin-top:2px" id="out-range">—</p></div>
      <div class="stock-totals">
        <span id="out-totals"></span>
        <button class="btn btn-danger btn-sm" type="button" data-batch-cancel disabled>${icon("trash", 14)} Batalkan terpilih (<span id="out-selected">0</span>)</button>
      </div>
    </div>
    <div id="out-table"><div class="loading-block"><span class="spinner"></span><span>Memuat barang keluar…</span></div></div>
  </div>`;
}

function renderTable() {
  const holder = document.getElementById("out-table");
  if (!holder) return;
  if (!state.rows) {
    holder.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat barang keluar…</span></div>`;
    return;
  }
  const range = document.getElementById("out-range");
  if (range) range.textContent = `${fmtDate(state.start)} — ${fmtDate(state.end)}`;
  const totals = state.rows.reduce((acc, row) => {
    acc.qty += Number(row.qty || 0);
    return acc;
  }, { qty: 0 });
  const box = document.getElementById("out-totals");
  if (box) {
    box.innerHTML = `<span class="stock-total-item"><strong>${esc(fmtQty(state.rows.length))}</strong> transaksi</span>
      <span class="stock-total-item"><strong>${esc(fmtQty(totals.qty))}</strong> batang</span>`;
  }
  const batchButton = document.querySelector("[data-batch-cancel]");
  if (batchButton) batchButton.disabled = state.selected.size === 0;
  const selectedBox = document.getElementById("out-selected");
  if (selectedBox) selectedBox.textContent = String(state.selected.size);
  if (!state.rows.length) {
    holder.innerHTML = emptyState({
      iconName: "outgoing",
      title: "Belum ada barang keluar",
      text: "Catat pengeluaran dari lot yang tersedia di gudang.",
      action: '<button class="btn btn-primary btn-sm" type="button" data-create>Barang keluar baru</button>',
    });
    holder.querySelector("[data-create]")?.addEventListener("click", startCreate);
    return;
  }
  holder.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
    <th><input type="checkbox" id="out-check-all" ${state.rows.every((row) => state.selected.has(row.id)) ? "checked" : ""} aria-label="Pilih semua"></th>
    <th>Tanggal</th><th>Barang</th><th>Ukuran</th><th>Lokasi</th><th>Lot sumber</th><th class="num">Qty</th><th>Catatan</th><th>Petugas</th><th></th>
  </tr></thead><tbody>
  ${state.rows.map((row) => `<tr class="is-clickable" data-out-id="${row.id}" data-context-edit="[data-edit='${row.id}']" data-context-delete="[data-cancel-one='${row.id}']">
    <td><input type="checkbox" data-select="${row.id}" ${state.selected.has(row.id) ? "checked" : ""} aria-label="Pilih transaksi"></td>
    <td><div class="cell-title">${esc(fmtDate(row.trx_date))}</div><div class="cell-sub">${esc(row.created_at ? String(row.created_at).slice(0, 16).replace("T", " ") : "")}</div></td>
    <td><div class="cell-title">${esc(row.name)}</div><div class="cell-sub">${esc(row.code)}${row.supplier ? ` · ${esc(row.supplier)}` : ""}</div></td>
    <td><span class="size">${esc(row.size_display)}</span></td>
    <td><span class="loc">${icon("mapPin", 12)} ${esc(row.location || "—")}</span></td>
    <td><div class="cell-sub">${esc(row.source_number || "—")}</div><div class="cell-sub">${row.source_date ? esc(fmtDate(row.source_date)) : ""}</div></td>
    <td class="num strong">${esc(fmtQty(row.qty))}</td>
    <td><div class="cell-sub" style="max-width:190px;white-space:normal">${esc(row.note || "—")}</div></td>
    <td>${esc(row.username || "—")}${row.is_locked ? `<div>${badge("Terkunci", "neutral")}</div>` : ""}</td>
    <td><div class="row-actions">
      <button class="icon-btn" type="button" data-view="${row.id}" title="Detail">${icon("eye", 15)}</button>
      <button class="icon-btn" type="button" data-edit="${row.id}" title="Ubah" ${row.is_locked ? "disabled" : ""}>${icon("edit", 15)}</button>
      <button class="icon-btn" type="button" data-cancel-one="${row.id}" title="Batalkan" ${row.is_locked ? "disabled" : ""}>${icon("trash", 15)}</button>
    </div></td>
  </tr>`).join("")}
  </tbody></table></div>
  <div class="table-footer"><span>Menampilkan <strong>${esc(fmtQty(state.rows.length))}</strong> transaksi</span><span>Total ${esc(fmtQty(totals.qty))} batang</span></div>`;
  document.getElementById("out-check-all")?.addEventListener("change", (event) => {
    if (event.target.checked) state.rows.forEach((row) => state.selected.add(row.id));
    else state.selected.clear();
    renderTable();
  });
}

async function loadRows() {
  state.rows = null;
  renderTable();
  try {
    const data = await api.get("/api/outgoing", {
      start: state.start,
      end: state.end,
      query: state.query,
    });
    state.rows = data.rows || [];
    state.selected.clear();
    renderTable();
  } catch (error) {
    const holder = document.getElementById("out-table");
    if (holder) holder.innerHTML = emptyState({ iconName: "alert", title: "Barang keluar gagal dimuat", text: error.message });
  }
}

function findRow(id) {
  return (state.rows || []).find((row) => Number(row.id) === Number(id));
}

async function openDetail(id) {
  const drawer = openDrawer({
    title: "Detail barang keluar",
    eyebrow: "Transaksi gudang",
    size: "md",
    iconName: "outgoing",
    body: `<div class="loading-block"><span class="spinner"></span><span>Memuat transaksi…</span></div>`,
  });
  let row;
  try {
    row = await api.get(`/api/outgoing/${id}`);
  } catch (error) {
    drawer.bodyEl.innerHTML = `<div class="empty-state" style="padding:28px"><span class="empty-icon">${icon("alert", 24)}</span><strong>Transaksi gagal dimuat</strong><p>${esc(error.message)}</p></div>`;
    return;
  }
  const locked = Boolean(findRow(id)?.is_locked);
  drawer.bodyEl.innerHTML = `
    <div class="note-detail-head">
      <div class="note-copy">
        <div class="note-title-line"><strong>${esc(row.name)}</strong><span class="size">${esc(row.size_display || fmtQty(row.qty))}</span>${locked ? badge("Terkunci", "neutral") : badge("Aktif", "green", true)}</div>
        <div class="note-sub">${esc(row.code)} · ${esc(fmtDate(row.trx_date))} · ${esc(row.location || "tanpa lokasi")}</div>
      </div>
      <div class="note-amount"><span>Qty keluar</span><strong>${esc(fmtQty(row.qty))}</strong></div>
    </div>
    <div class="meta-grid">
      <div class="meta-cell"><span>Volume</span><strong>${esc(fmtM3(row.m3))} m³</strong></div>
      <div class="meta-cell"><span>Lot sumber</span><strong>${esc(row.source_number || "—")}</strong></div>
      <div class="meta-cell"><span>Tanggal lot</span><strong>${esc(fmtDate(row.source_date))}</strong></div>
      <div class="meta-cell"><span>Pemasok lot</span><strong>${esc(row.source_supplier || row.supplier || "—")}</strong></div>
      <div class="meta-cell"><span>Petugas</span><strong>${esc(row.username || "—")}</strong></div>
      <div class="meta-cell"><span>Dibuat</span><strong>${esc(fmtDateTime(row.created_at))}</strong></div>
      <div class="meta-cell"><span>Sisa lot sekarang</span><strong>${row.max_qty === null || row.max_qty === undefined ? "—" : esc(fmtQty(row.max_qty))}</strong></div>
      <div class="meta-cell"><span>Harga lot</span><strong>${esc(fmtMoney(row.price))}/m³</strong></div>
    </div>
    ${row.note ? `<div class="notice-line" style="margin-top:14px">${icon("info", 14)} ${esc(row.note)}</div>` : ""}`;
  const footer = drawer.footerEl;
  if (!footer) return;
  footer.innerHTML = `<button class="btn btn-ghost" type="button" data-layer-close>Tutup</button>
    <a class="btn btn-secondary" href="#/stock?product=${row.product_id || ""}" data-stock-link>${icon("package", 15)} Lihat stok</a>
    ${locked ? "" : `<button class="btn btn-secondary" type="button" data-edit><span class="btn-ico">${icon("edit", 15)}</span> Ubah</button>
    <button class="btn btn-danger" type="button" data-cancel>${icon("trash", 15)} Batalkan</button>`}`;
  footer.querySelector("[data-stock-link]")?.addEventListener("click", () => drawer.close());
  footer.querySelector("[data-edit]")?.addEventListener("click", () => {
    drawer.close();
    openEdit(row);
  });
  footer.querySelector("[data-cancel]")?.addEventListener("click", async () => {
    const values = await promptReason({
      title: "Batalkan barang keluar?",
      message: `Transaksi ${fmtQty(row.qty)} batang akan dihapus dan sisa lot kembali.`,
      confirmLabel: "Batalkan transaksi",
    });
    if (!values) return;
    try {
      await api.post("/api/outgoing/cancel", { ids: [row.id], reason: values.reason || "" });
      toast.success("Barang keluar dibatalkan.");
      drawer.close();
      await loadRows();
      refreshAllMeta().catch(() => {});
    } catch (error) {
      toast.error(error.message);
    }
  });
}

function openEdit(row) {
  const minDate = String(row.source_date || "").slice(0, 10);
  const maxQty = Number(row.max_qty ?? row.qty ?? 0);
  openForm({
    title: "Ubah barang keluar",
    eyebrow: "Koreksi transaksi",
    subtitle: `${row.name} · ${row.size_display || ""} · lot ${row.source_number || "-"}`,
    fields: [
      { name: "date", label: "Tanggal keluar", type: "date", required: true, value: String(row.trx_date || "").slice(0, 10), min: minDate, max: todayISO() },
      { name: "qty", label: "Qty", type: "number", required: true, min: 0.0001, max: maxQty, step: "any", value: row.qty, help: `Maksimum ${fmtQty(maxQty)} berdasarkan sisa lot dan stok.` },
      { name: "location", label: "Lokasi", type: "select", options: locations({ includeEmpty: true }), value: row.location || "", full: true },
      { name: "note", label: "Catatan", type: "textarea", rows: 3, full: true, maxlength: 300, value: row.note || "" },
    ],
    submitLabel: "Simpan perubahan",
    onSubmit: async (values) => {
      await api.put(`/api/outgoing/${row.id}`, {
        qty: values.qty,
        date: values.date,
        note: values.note || "",
        location: values.location || "",
      });
      toast.success("Barang keluar diperbarui.");
      await loadRows();
    },
  });
}

async function startCreate() {
  let rows;
  try {
    const data = await api.get("/api/stock");
    rows = (data.rows || []).filter((row) => Number(row.stock) > 0);
  } catch (error) {
    toast.error(error.message);
    return;
  }
  if (!rows.length) {
    toast.warn("Belum ada stok yang dapat dikeluarkan.");
    return;
  }
  const stockOptions = rows.map((row) => ({
    value: `${row.product_id}|${row.size}`,
    label: `${row.code} · ${row.name} · ${row.size_display} (${fmtQty(row.stock)})`,
  }));
  const first = rows[0];
  const firstLocations = Object.entries(first.locations || {}).filter(([, qty]) => Number(qty) > 0)
    .map(([code]) => ({ value: code, label: code || "Tanpa lokasi" }));
  openForm({
    title: "Barang keluar baru",
    eyebrow: "Pengeluaran stok",
    subtitle: "Pilih barang, lokasi, lalu lot sumber yang akan dikurangi.",
    fields: [
      { name: "stock", label: "Barang & ukuran", type: "select", options: stockOptions, required: true, full: true },
      { name: "location", label: "Lokasi asal", type: "select", options: firstLocations, required: true },
      { name: "source_id", label: "Lot sumber", type: "select", options: [], required: true },
      { name: "date", label: "Tanggal keluar", type: "date", required: true, value: todayISO(), max: todayISO() },
      { name: "qty", label: "Qty", type: "number", required: true, min: 0.0001, step: "any", value: "", help: "Kapasitas mengikuti lot dan stok lokasi." },
      { name: "note", label: "Catatan", type: "textarea", rows: 3, full: true, maxlength: 300, placeholder: "Tujuan atau nomor dokumen keluar" },
    ],
    submitLabel: "Catat barang keluar",
    submitIcon: "outgoing",
    onMount: (layer) => {
      const form = layer.rootEl.querySelector("#generic-form");
      const stockSelect = form.elements.namedItem("stock");
      const locationSelect = form.elements.namedItem("location");
      const lotSelect = form.elements.namedItem("source_id");
      const qtyInput = form.elements.namedItem("qty");
      let lots = [];
      const loadLots = async () => {
        const [productId, size] = String(stockSelect.value || "").split("|");
        const location = locationSelect.value;
        lotSelect.innerHTML = `<option value="">Memuat lot…</option>`;
        try {
          const data = await api.get("/api/stock/lots", { product_id: productId, size, location });
          lots = data.lots || [];
          lotSelect.innerHTML = lots.length
            ? lots.map((lot) => `<option value="${lot.id}">${esc(lot.trx_number || `Lot #${lot.id}`)} · sisa ${esc(fmtQty(lot.remaining))} · tersedia ${esc(fmtQty(lot.capacity))}</option>`).join("")
            : `<option value="">Tidak ada lot tersedia</option>`;
          if (lots.length && qtyInput) qtyInput.max = String(lots[0].capacity || "");
          if (qtyInput) qtyInput.placeholder = lots.length ? `Maks ${fmtQty(lots[0].capacity)}` : "";
        } catch (error) {
          lotSelect.innerHTML = `<option value="">${esc(error.message)}</option>`;
        }
      };
      const syncLocations = () => {
        const [productId, size] = String(stockSelect.value || "").split("|");
        const row = rows.find((item) => Number(item.product_id) === Number(productId) && item.size === size);
        const entries = Object.entries(row?.locations || {}).filter(([, qty]) => Number(qty) > 0);
        locationSelect.innerHTML = entries.map(([code, qty]) => `<option value="${esc(code)}">${esc(code || "Tanpa lokasi")} · ${esc(fmtQty(qty))}</option>`).join("");
        loadLots();
      };
      stockSelect.addEventListener("change", syncLocations);
      locationSelect.addEventListener("change", loadLots);
      lotSelect.addEventListener("change", () => {
        const lot = lots.find((item) => String(item.id) === String(lotSelect.value));
        if (lot && qtyInput) {
          qtyInput.max = String(lot.capacity || "");
          qtyInput.placeholder = `Maks ${fmtQty(lot.capacity)}`;
        }
      });
      loadLots();
    },
    onSubmit: async (values) => {
      if (!values.source_id) throw new Error("Pilih lot sumber terlebih dahulu.");
      await api.post("/api/outgoing", {
        source_id: values.source_id,
        location: values.location,
        qty: values.qty,
        date: values.date,
        note: values.note || "",
      });
      toast.success("Barang keluar tercatat.");
      await loadRows();
      refreshAllMeta().catch(() => {});
    },
  });
}

async function cancelSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const values = await promptReason({
    title: `Batalkan ${ids.length} transaksi?`,
    message: "Transaksi barang keluar terpilih akan dihapus dan sisa lot dikembalikan.",
    confirmLabel: "Batalkan terpilih",
  });
  if (!values) return;
  try {
    const result = await api.post("/api/outgoing/cancel", { ids, reason: values.reason || "" });
    toast.success(`${fmtQty(result.cancelled)} transaksi dibatalkan.`);
    state.selected.clear();
    await loadRows();
    refreshAllMeta().catch(() => {});
  } catch (error) {
    toast.error(error.message);
  }
}

export async function render(root) {
  root.innerHTML = layout();
  const form = root.querySelector("#outgoing-filters");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.start = form.querySelector("#out-start").value || state.start;
    state.end = form.querySelector("#out-end").value || state.end;
    state.query = form.querySelector("#out-query").value.trim();
    loadRows();
  });
  root.querySelector("[data-create]")?.addEventListener("click", startCreate);
  root.querySelector("[data-export]")?.addEventListener("click", (event) => {
    downloadExport("transactions", {
      kind: "KELUAR",
      start: state.start,
      end: state.end,
      query: state.query,
    }, "laporan-keluar.xlsx", event.currentTarget).catch(() => {});
  });
  root.querySelector("[data-batch-cancel]")?.addEventListener("click", cancelSelected);
  root.addEventListener("change", (event) => {
    const box = event.target.closest("[data-select]");
    if (!box) return;
    const id = Number(box.dataset.select);
    if (box.checked) state.selected.add(id);
    else state.selected.delete(id);
    const batchButton = document.querySelector("[data-batch-cancel]");
    if (batchButton) batchButton.disabled = state.selected.size === 0;
    const selectedBox = document.getElementById("out-selected");
    if (selectedBox) selectedBox.textContent = String(state.selected.size);
  });
  root.addEventListener("click", (event) => {
    if (event.target.closest("input, button, a")) return;
    const row = event.target.closest("tr[data-out-id]");
    if (row) openDetail(row.dataset.outId);
  });
  root.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view]");
    if (view) {
      openDetail(view.dataset.view);
      return;
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      const row = findRow(edit.dataset.edit);
      if (row) openEdit(row);
      return;
    }
    const cancel = event.target.closest("[data-cancel-one]");
    if (cancel) {
      const row = findRow(cancel.dataset.cancelOne);
      if (!row) return;
      promptReason({
        title: "Batalkan barang keluar?",
        message: `Transaksi ${fmtQty(row.qty)} batang ${row.name} akan dihapus dan sisa lot kembali.`,
        confirmLabel: "Batalkan transaksi",
      }).then(async (values) => {
        if (!values) return;
        try {
          await api.post("/api/outgoing/cancel", { ids: [row.id], reason: values.reason || "" });
          toast.success("Barang keluar dibatalkan.");
          await loadRows();
          refreshAllMeta().catch(() => {});
        } catch (error) {
          toast.error(error.message);
        }
      });
    }
  });
  await loadRows();
}
