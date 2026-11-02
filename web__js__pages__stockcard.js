import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  emptyState, esc, firstOfMonth, fmtDate, fmtM3, fmtQty, fmtSize,
  toast, todayISO,
} from "../ui.js";
import {
  downloadExport, locations, masters, pageHead,
} from "./common.js";

const state = {
  combos: [],
  key: "",
  location: "",
  start: firstOfMonth(),
  end: todayISO(),
  card: null,
};

function productName(productId, size) {
  const product = (masters().products || []).find((row) => Number(row.id) === Number(productId));
  const label = product ? `${product.code} · ${product.name}` : `Barang #${productId}`;
  return `${label} · ${fmtSize(size)}`;
}

function layout() {
  return `${pageHead({
    eyebrow: "Gudang",
    title: "Kartu Stok",
    subtitle: "Jejak mutasi satu barang, ukuran, dan lokasi dari saldo awal hingga saldo akhir.",
    actions: `<button class="btn btn-secondary" type="button" data-export>${icon("download", 16)} Ekspor Excel</button>
      <button class="btn btn-secondary" type="button" data-print>${icon("printer", 16)} Cetak</button>`,
  })}
  <form class="filters" id="card-filters">
    <div class="field grow-field"><label class="field-label" for="card-product">Barang & ukuran</label>
      <div class="select-wrap"><select class="input" id="card-product"><option value="">Memuat pilihan…</option></select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="field"><label class="field-label" for="card-location">Lokasi</label>
      <div class="select-wrap"><select class="input" id="card-location">
        ${locations({ includeEmpty: true }).map((row) => `<option value="${esc(row.value)}" ${state.location === row.value ? "selected" : ""}>${esc(row.label)}</option>`).join("")}
      </select>${icon("chevronDown", 15, "select-chevron")}</div>
    </div>
    <div class="field"><label class="field-label" for="card-start">Dari</label><input class="input" id="card-start" type="date" value="${esc(state.start)}"></div>
    <div class="field"><label class="field-label" for="card-end">Sampai</label><input class="input" id="card-end" type="date" value="${esc(state.end)}"></div>
    <div class="filter-actions"><button class="btn btn-primary" type="submit">${icon("search", 15)} Tampilkan</button></div>
  </form>
  <div id="card-body"><div class="loading-block"><span class="spinner"></span><span>Menyiapkan kartu stok…</span></div></div>`;
}

function fillComboOptions() {
  const select = document.getElementById("card-product");
  if (!select) return;
  if (!state.combos.length) {
    select.innerHTML = `<option value="">Belum ada barang dengan stok</option>`;
    return;
  }
  const stillExists = state.combos.some((combo) => combo.key === state.key);
  if (!stillExists) state.key = state.combos[0].key;
  select.innerHTML = state.combos.map((combo) => `<option value="${esc(combo.key)}" ${combo.key === state.key ? "selected" : ""}>${esc(combo.label)}</option>`).join("");
}

function bestLocation() {
  const combo = state.combos.find((entry) => entry.key === state.key);
  const entries = Object.entries(combo?.locations || {})
    .filter(([, qty]) => Number(qty) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return entries.length ? entries[0][0] : "";
}

function stat(label, value, sub) {
  return `<div class="stat-card stat-green"><div class="stat-top"><span class="stat-icon">${icon("package", 17)}</span><span class="stat-label">${esc(label)}</span></div><strong class="stat-value">${esc(value)}</strong>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}</div>`;
}

function renderCard() {
  const holder = document.getElementById("card-body");
  if (!holder) return;
  if (!state.key) {
    holder.innerHTML = emptyState({
      iconName: "book",
      title: "Belum ada kartu stok",
      text: "Kartu stok membutuhkan barang dengan riwayat stok. Catat penerimaan atau pilih kombinasi lain.",
    });
    return;
  }
  if (!state.card) {
    holder.innerHTML = `<div class="card"><div class="loading-block"><span class="spinner"></span><span>Memuat mutasi kartu stok…</span></div></div>`;
    return;
  }
  const card = state.card;
  const movements = card.movements || [];
  holder.innerHTML = `
    <div class="card card-pad">
      <div class="card-print-head">
        <div>
          <h2>${esc(card.product.name)}</h2>
          <p>${esc(card.product.code)} · ukuran ${esc(card.size_display)} · lokasi ${esc(card.location || "tanpa lokasi")}</p>
        </div>
        <div style="text-align:right">
          <div class="mini-label">Periode</div>
          <strong style="font-size:12px">${esc(fmtDate(card.start))} — ${esc(fmtDate(card.end))}</strong>
          <p style="font-size:10px;color:var(--muted);margin-top:3px">${esc(fmtQty(movements.length))} pergerakan</p>
        </div>
      </div>
      <div class="stock-card-summary">
        ${stat("Saldo awal", `${fmtQty(card.opening)} batang`, `${fmtM3(card.opening_m3)} m³`)}
        ${stat("Masuk", `${fmtQty(movements.reduce((sum, row) => sum + Number(row.in_qty || 0), 0))} batang`, `${fmtM3(card.in_m3)} m³`)}
        ${stat("Keluar", `${fmtQty(movements.reduce((sum, row) => sum + Number(row.out_qty || 0), 0))} batang`, `${fmtM3(card.out_m3)} m³`)}
        ${stat("Saldo akhir", `${fmtQty(card.closing)} batang`, `${fmtM3(card.closing_m3)} m³`)}
      </div>
      <div class="table-wrap"><table class="table"><thead><tr>
        <th>Tanggal</th><th>Jenis</th><th>Referensi</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num">Saldo</th><th>Catatan</th>
      </tr></thead><tbody>
      ${movements.length ? movements.map((row) => `<tr>
        <td><div class="cell-title">${esc(fmtDate(row.date))}</div></td>
        <td>${esc(row.kind)}</td>
        <td><div class="cell-sub" style="white-space:normal;max-width:230px">${esc(row.reference || "—")}</div></td>
        <td class="num movement-in">${Number(row.in_qty) ? esc(fmtQty(row.in_qty)) : "—"}</td>
        <td class="num movement-out">${Number(row.out_qty) ? esc(fmtQty(row.out_qty)) : "—"}</td>
        <td class="num strong">${esc(fmtQty(row.balance))}</td>
        <td><div class="cell-sub" style="white-space:normal;max-width:210px">${esc(row.note || "—")}</div></td>
      </tr>`).join("") : `<tr><td colspan="7"><div class="empty-state" style="padding:26px"><strong>Tidak ada pergerakan pada periode ini</strong><p>Saldo awal tetap ${esc(fmtQty(card.opening))} batang.</p></div></td></tr>`}
      </tbody></table></div>
      <div class="stock-toolbar" style="margin-top:14px;margin-bottom:0">
        <div class="stock-totals">
          <span class="stock-total-item"><strong>${esc(fmtQty(card.opening))}</strong> saldo awal</span>
          <span class="stock-total-item"><strong>${esc(fmtM3(card.in_m3))}</strong> m³ masuk</span>
          <span class="stock-total-item"><strong>${esc(fmtM3(card.out_m3))}</strong> m³ keluar</span>
        </div>
        <div class="stock-totals"><span class="stock-total-item">Saldo akhir <strong>${esc(fmtQty(card.closing))} batang · ${esc(fmtM3(card.closing_m3))} m³</strong></span></div>
      </div>
    </div>`;
}

async function loadCard() {
  state.card = null;
  renderCard();
  if (!state.key) return;
  const [productId, ...sizeParts] = state.key.split("|");
  const size = sizeParts.join("|");
  try {
    state.card = await api.get("/api/stock-card", {
      product_id: productId,
      size,
      location: state.location,
      start: state.start,
      end: state.end,
    });
    renderCard();
  } catch (error) {
    const holder = document.getElementById("card-body");
    if (holder) holder.innerHTML = `<div class="card">${emptyState({ iconName: "alert", title: "Kartu stok gagal dimuat", text: error.message })}</div>`;
  }
}

async function loadCombos() {
  try {
    const data = await api.get("/api/stock");
    state.combos = (data.rows || []).map((row) => ({
      key: `${row.product_id}|${row.size}`,
      label: `${row.code} · ${row.name} · ${row.size_display} (${fmtQty(row.stock)})`,
      locations: row.locations || {},
    }));
  } catch (error) {
    toast.error(error.message);
    state.combos = [];
  }
  if (state.key && !state.combos.some((combo) => combo.key === state.key)) {
    const [productId, ...sizeParts] = state.key.split("|");
    const size = sizeParts.join("|");
    state.combos.unshift({ key: state.key, label: productName(productId, size) });
  }
  fillComboOptions();
}

export async function render(root, { route } = {}) {
  const query = route?.query;
  const defaultLocation = !query?.has("location");
  state.key = query?.get("product")
    ? `${query.get("product")}|${query.get("size") || ""}`
    : "";
  state.location = query?.get("location") || "";
  state.start = query?.get("start") || firstOfMonth();
  state.end = query?.get("end") || todayISO();
  root.innerHTML = layout();
  const cardLocation = root.querySelector("#card-location");
  if (cardLocation) cardLocation.value = state.location;
  await loadCombos();
  if (defaultLocation) {
    state.location = bestLocation();
    if (cardLocation) cardLocation.value = state.location;
  }
  const form = root.querySelector("#card-filters");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.key = form.querySelector("#card-product").value;
    state.location = form.querySelector("#card-location").value;
    state.start = form.querySelector("#card-start").value || state.start;
    state.end = form.querySelector("#card-end").value || state.end;
    loadCard();
  });
  root.querySelector("#card-product")?.addEventListener("change", (event) => {
    state.key = event.target.value;
    loadCard();
  });
  root.querySelector("#card-location")?.addEventListener("change", (event) => {
    state.location = event.target.value;
    loadCard();
  });
  root.querySelector("[data-export]")?.addEventListener("click", (event) => {
    if (!state.key) return;
    const [productId, ...sizeParts] = state.key.split("|");
    downloadExport("stock-card", {
      product_id: productId,
      size: sizeParts.join("|"),
      location: state.location,
      start: state.start,
      end: state.end,
    }, "kartu-stok.xlsx", event.currentTarget).catch(() => {});
  });
  root.querySelector("[data-print]")?.addEventListener("click", () => window.print());
  await loadCard();
}
