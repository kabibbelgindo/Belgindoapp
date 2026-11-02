import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  emptyState, esc, firstOfMonth, fmtDate, fmtM3, fmtQty, openForm, toast, todayISO,
} from "../ui.js";
import {
  downloadExport, locations, pageHead, refreshAllMeta,
} from "./common.js";

const state = {
  start: firstOfMonth(),
  end: todayISO(),
  query: "",
  rows: null,
};

function layout() {
  return `${pageHead({
    eyebrow: "Gudang",
    title: "Mutasi Lokasi",
    subtitle: "Pindahkan stok antar lokasi tanpa mengubah total persediaan.",
    actions: `<button class="btn btn-secondary" type="button" data-export>${icon("download", 16)} Ekspor Excel</button>
      <button class="btn btn-primary" type="button" data-create>${icon("transfer", 16)} Mutasi baru</button>`,
  })}
  <form class="filters" id="transfer-filters">
    <div class="field"><label class="field-label" for="tr-start">Dari</label><input class="input" id="tr-start" type="date" value="${esc(state.start)}"></div>
    <div class="field"><label class="field-label" for="tr-end">Sampai</label><input class="input" id="tr-end" type="date" value="${esc(state.end)}"></div>
    <div class="field grow-field"><label class="field-label" for="tr-query">Cari</label><input class="input" id="tr-query" type="search" value="${esc(state.query)}" placeholder="Barang, lokasi, catatan…"></div>
    <div class="filter-actions"><button class="btn btn-secondary" type="submit">${icon("search", 15)} Terapkan</button></div>
  </form>
  <div class="card card-flush">
    <div class="card-header with-line stock-toolbar" style="padding-bottom:14px">
      <div><h2 style="font-size:15px;font-weight:650">Riwayat mutasi</h2><p style="color:var(--muted);font-size:11px;margin-top:2px" id="tr-range">—</p></div>
      <div class="stock-totals" id="tr-totals"></div>
    </div>
    <div id="tr-table"><div class="loading-block"><span class="spinner"></span><span>Memuat mutasi…</span></div></div>
  </div>`;
}

function renderTable() {
  const holder = document.getElementById("tr-table");
  if (!holder) return;
  if (!state.rows) {
    holder.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat mutasi…</span></div>`;
    return;
  }
  const range = document.getElementById("tr-range");
  if (range) range.textContent = `${fmtDate(state.start)} — ${fmtDate(state.end)}`;
  const totals = state.rows.reduce((acc, row) => {
    acc.qty += Number(row.qty || 0);
    acc.m3 += Number(row.m3 || 0);
    return acc;
  }, { qty: 0, m3: 0 });
  const box = document.getElementById("tr-totals");
  if (box) {
    box.innerHTML = `<span class="stock-total-item"><strong>${esc(fmtQty(state.rows.length))}</strong> mutasi</span>
      <span class="stock-total-item"><strong>${esc(fmtQty(totals.qty))}</strong> batang</span>
      <span class="stock-total-item"><strong>${esc(fmtM3(totals.m3))}</strong> m³</span>`;
  }
  if (!state.rows.length) {
    holder.innerHTML = emptyState({
      iconName: "transfer",
      title: "Belum ada mutasi lokasi",
      text: "Catat perpindahan stok antar lokasi agar posisi tiap gudang akurat.",
      action: '<button class="btn btn-primary btn-sm" type="button" data-create>Mutasi baru</button>',
    });
    holder.querySelector("[data-create]")?.addEventListener("click", startCreate);
    return;
  }
  holder.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
    <th>Tanggal</th><th>Barang</th><th>Ukuran</th><th>Asal → Tujuan</th><th class="num">Qty</th><th class="num">m³</th><th>Catatan</th><th>Petugas</th>
  </tr></thead><tbody>
  ${state.rows.map((row) => `<tr>
    <td><div class="cell-title">${esc(fmtDate(row.transfer_date))}</div><div class="cell-sub">${esc(String(row.created_at || "").slice(11, 16))}</div></td>
    <td><div class="cell-title">${esc(row.name)}</div><div class="cell-sub">${esc(row.code)}</div></td>
    <td><span class="size">${esc(row.size_display)}</span></td>
    <td><div class="cell-title" style="font-size:11px">${esc(row.from_location)} <span style="color:var(--muted)">→</span> ${esc(row.to_location)}</div></td>
    <td class="num strong">${esc(fmtQty(row.qty))}</td>
    <td class="num">${esc(fmtM3(row.m3))}</td>
    <td><div class="cell-sub" style="max-width:220px;white-space:normal">${esc(row.note || "—")}</div></td>
    <td>${esc(row.username || "—")}</td>
  </tr>`).join("")}
  </tbody></table></div>
  <div class="table-footer"><span>Menampilkan <strong>${esc(fmtQty(state.rows.length))}</strong> mutasi</span><span>${esc(fmtM3(totals.m3))} m³ dipindahkan</span></div>`;
}

async function loadRows() {
  state.rows = null;
  renderTable();
  try {
    const data = await api.get("/api/transfers", {
      start: state.start,
      end: state.end,
      query: state.query,
    });
    state.rows = data.rows || [];
    renderTable();
  } catch (error) {
    const holder = document.getElementById("tr-table");
    if (holder) holder.innerHTML = emptyState({ iconName: "alert", title: "Mutasi gagal dimuat", text: error.message });
  }
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
    toast.warn("Belum ada stok yang dapat dimutasi.");
    return;
  }
  const stockOptions = rows.map((row) => ({
    value: `${row.product_id}|${row.size}`,
    label: `${row.code} · ${row.name} · ${row.size_display} (${fmtQty(row.stock)})`,
  }));
  const first = rows[0];
  const firstLocations = Object.entries(first.locations || {}).filter(([, qty]) => Number(qty) > 0)
    .map(([code]) => ({ value: code, label: `${code || "Tanpa lokasi"} · ${fmtQty(first.locations[code])}` }));
  openForm({
    title: "Mutasi stok baru",
    eyebrow: "Perpindahan lokasi",
    subtitle: "Total stok tidak berubah; hanya sebaran lokasi yang berpindah.",
    fields: [
      { name: "stock", label: "Barang & ukuran", type: "select", options: stockOptions, required: true, full: true },
      { name: "from_location", label: "Lokasi asal", type: "select", options: firstLocations, required: true },
      { name: "to_location", label: "Lokasi tujuan", type: "select", options: locations(), required: true },
      { name: "qty", label: "Qty", type: "number", required: true, min: 0.0001, step: "any", value: "", help: "Tidak boleh melebihi stok di lokasi asal." },
      { name: "date", label: "Tanggal mutasi", type: "date", required: true, value: todayISO(), max: todayISO() },
      { name: "note", label: "Catatan", type: "textarea", rows: 3, full: true, maxlength: 300, placeholder: "Alasan atau nomor dokumen mutasi" },
    ],
    submitLabel: "Simpan mutasi",
    submitIcon: "transfer",
    onMount: (layer) => {
      const form = layer.rootEl.querySelector("#generic-form");
      const stockSelect = form.elements.namedItem("stock");
      const fromSelect = form.elements.namedItem("from_location");
      const qtyInput = form.elements.namedItem("qty");
      const syncFrom = () => {
        const [productId, size] = String(stockSelect.value || "").split("|");
        const row = rows.find((item) => Number(item.product_id) === Number(productId) && item.size === size);
        const entries = Object.entries(row?.locations || {}).filter(([, qty]) => Number(qty) > 0);
        fromSelect.innerHTML = entries.map(([code, qty]) => `<option value="${esc(code)}">${esc(code || "Tanpa lokasi")} · ${esc(fmtQty(qty))}</option>`).join("");
        if (qtyInput) {
          const max = entries.length ? Math.max(...entries.map(([, qty]) => Number(qty))) : "";
          qtyInput.max = max ? String(max) : "";
          qtyInput.placeholder = max ? `Maks ${fmtQty(max)}` : "";
        }
      };
      stockSelect.addEventListener("change", syncFrom);
      syncFrom();
    },
    onSubmit: async (values) => {
      const [productId, size] = String(values.stock || "").split("|");
      if (!productId || !size) throw new Error("Pilih barang dan ukuran terlebih dahulu.");
      await api.post("/api/transfers", {
        product_id: Number(productId),
        size,
        from_location: values.from_location,
        to_location: values.to_location,
        qty: values.qty,
        date: values.date,
        note: values.note || "",
      });
      toast.success("Mutasi stok tercatat.");
      await loadRows();
      refreshAllMeta().catch(() => {});
    },
  });
}

export async function render(root) {
  root.innerHTML = layout();
  const form = root.querySelector("#transfer-filters");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.start = form.querySelector("#tr-start").value || state.start;
    state.end = form.querySelector("#tr-end").value || state.end;
    state.query = form.querySelector("#tr-query").value.trim();
    loadRows();
  });
  root.querySelector("[data-create]")?.addEventListener("click", startCreate);
  root.querySelector("[data-export]")?.addEventListener("click", (event) => {
    downloadExport("transfers", {
      start: state.start,
      end: state.end,
      query: state.query,
    }, "mutasi-lokasi.xlsx", event.currentTarget).catch(() => {});
  });
  await loadRows();
}
