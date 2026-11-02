import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  badge, confirmDialog, emptyState, esc, fmtMoney, fmtQty, initials, openForm, toast,
} from "../ui.js";
import {
  loadingCard, meta, priceOptions, refreshAllMeta, specsFor,
} from "./common.js";
import { permissions } from "../state.js";

const SECTIONS = [
  { key: "products", label: "Barang", icon: "package" },
  { key: "sellers", label: "Penjual", icon: "users" },
  { key: "locations", label: "Lokasi", icon: "mapPin" },
  { key: "specs", label: "Ukuran", icon: "sliders" },
  { key: "prices", label: "Harga", icon: "tag" },
];

const state = {
  section: "products",
  root: null,
  main: null,
  data: null,
  search: "",
  seq: 0,
};

function perms() {
  return permissions();
}

function canStatus() {
  return Boolean(perms().change_master_status);
}

function sectionInfo(key = state.section) {
  return SECTIONS.find((section) => section.key === key) || SECTIONS[0];
}

function ensureOption(options, value, label) {
  if (value === null || value === undefined || value === "") return options;
  return options.some((option) => String(option.value) === String(value))
    ? options
    : [{ value, label: label || String(value) }, ...options];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/* ------------------------------------------------------------------ shell */

function navHTML() {
  return `<nav class="master-nav" aria-label="Bagian data master">
    ${SECTIONS.map((section) => `<a href="#/master/${section.key}" class="${section.key === state.section ? "is-active" : ""}">
      ${icon(section.icon, 15)} ${esc(section.label)}
    </a>`).join("")}
    <div class="nav-sep"></div>
    <a href="#/users">${icon("shield", 15)} Pengguna &amp; akses</a>
  </nav>`;
}

function pageHeadHTML() {
  return `<div class="page-head">
    <div>
      <span class="eyebrow">${icon("database", 13)} Sumber kebenaran</span>
      <h1>Data Master</h1>
      <p>Satu tempat untuk merawat katalog barang, penjual, lokasi gudang, daftar ukuran, dan harga acuan. Perubahan langsung tersedia pada seluruh formulir.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary" type="button" data-refresh-master>${icon("refresh", 16)} Segarkan</button>
    </div>
  </div>`;
}

function sectionHead(title, subtitle, countLabel, actionHTML = "") {
  return `<div class="master-head">
    <div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>
    <div class="page-actions">${actionHTML}<span class="badge badge-neutral" id="master-count">${esc(countLabel)}</span></div>
  </div>`;
}

/* ------------------------------------------------------------------ load */

async function loadSection() {
  const main = state.main;
  if (!main) return;
  const seq = ++state.seq;
  main.innerHTML = loadingCard("Memuat data master…");
  try {
    let data;
    if (state.section === "products") {
      data = (await api.get("/api/master/products")).products || [];
    } else if (state.section === "sellers") {
      data = (await api.get("/api/master/sellers")).sellers || [];
    } else if (state.section === "locations") {
      data = (await api.get("/api/master/locations")).locations || [];
    } else if (state.section === "specs") {
      data = await api.get("/api/master/specs");
    } else {
      data = (await api.get("/api/master/prices")).prices || [];
    }
    if (seq !== state.seq) return;
    state.data = data;
    paint();
  } catch (error) {
    if (seq !== state.seq) return;
    main.innerHTML = `<div class="card card-pad">${emptyState({
      iconName: "alert",
      title: "Data master gagal dimuat",
      text: error.message,
      action: '<button class="btn btn-secondary" type="button" data-retry-master>Muat ulang</button>',
    })}</div>`;
    main.querySelector("[data-retry-master]")?.addEventListener("click", loadSection);
  }
}

function paint() {
  const main = state.main;
  if (!main) return;
  main.innerHTML = sectionHTML();
  applySearch();
}

/* ------------------------------------------------------------------ products */

function renderProducts() {
  const rows = state.data || [];
  const tableRows = rows.length
    ? rows.map((product) => `<tr data-row data-context-edit="[data-action=edit-product][data-id='${product.id}']" class="${product.active ? "" : "is-muted"}">
        <td>
          <div class="cell-title">${esc(product.name)}</div>
          <div class="cell-sub"><span class="code-chip">${esc(product.code)}</span>${product.is_import ? ` ${badge("Impor", "blue")}` : ""}</div>
        </td>
        <td>${esc(product.size_default_display || "—")}</td>
        <td class="cell-sub">${esc(product.unit || "—")}</td>
        <td class="num">${esc(fmtMoney(product.active_price))}</td>
        <td class="num">${esc(fmtMoney(product.purchase_price))}</td>
        <td class="num">${esc(fmtQty(product.min_stock))}</td>
        <td>${product.active ? badge("Aktif", "green") : badge("Nonaktif", "neutral")}</td>
        <td>
          <div class="master-table-actions">
            <button class="icon-btn" type="button" title="Ubah barang" data-action="edit-product" data-id="${product.id}">${icon("edit", 15)}</button>
            ${canStatus() ? `<button class="icon-btn" type="button" title="${product.active ? "Nonaktifkan" : "Aktifkan"} barang" data-action="toggle-product" data-id="${product.id}">${icon(product.active ? "eyeOff" : "eye", 15)}</button>` : ""}
          </div>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="8" style="padding:0"><div class="empty-state" style="padding:36px 16px"><span class="empty-icon">${icon("package", 24)}</span><strong>Belum ada barang</strong><p>Tambahkan barang pertama untuk mulai mencatat penerimaan.</p></div></td></tr>`;
  return `${sectionHead("Katalog barang", "Kode, dimensi default, satuan, serta harga acuan per meter kubik.", `${rows.length} barang`,
    `<button class="btn btn-primary btn-sm" type="button" data-action="add-product">${icon("plus", 15)} Tambah barang</button>`)}
    <div class="filters" style="padding:11px 13px">
      <div class="field grow-field"><label class="field-label">Cari barang</label><input class="input" type="search" data-master-search placeholder="Nama atau kode barang…" value="${esc(state.search)}"></div>
      <span class="field-help" style="padding-bottom:10px">Kode barang hasil impor berawalan <span class="code-chip">IMP/</span></span>
    </div>
    <div class="card card-flush"><div class="table-wrap"><table class="table">
      <thead><tr><th>Barang</th><th>Dimensi default</th><th>Satuan</th><th class="num">Harga aktif/m³</th><th class="num">Harga beli</th><th class="num">Stok min.</th><th>Status</th><th></th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div></div>`;
}

function openProductForm(product = null) {
  const units = meta().constants?.product_units || ["BATANG", "LEMBAR", "KUBIK", "TON"];
  const unitOptions = units.map((unit) => ({ value: unit, label: unit }));
  const activePrice = Number(product?.active_price || 0);
  const priceChoices = ensureOption(
    [{ value: 0, label: "Tanpa harga aktif" }, ...priceOptions()],
    activePrice > 0 ? activePrice : "",
    activePrice > 0 ? `${fmtMoney(activePrice)} (di luar daftar)` : "",
  );
  const specChoices = (dimension) => ensureOption(
    specsFor(dimension).map((value) => ({ value, label: String(Number(value)) })),
    product?.[`spec_${dimension.toLowerCase()}`],
    `${Number(product?.[`spec_${dimension.toLowerCase()}`] || 0)} (di luar daftar)`,
  );
  openForm({
    title: product ? "Ubah barang" : "Tambah barang",
    eyebrow: "Data master · barang",
    subtitle: product ? "Perubahan harga aktif tidak mengubah transaksi yang sudah tercatat." : "Kode dapat dikosongkan untuk dibuat otomatis dari nama barang.",
    fields: [
      { name: "name", label: "Nama barang", type: "text", required: true, maxlength: 120, value: product?.name || "", full: true },
      { name: "code", label: "Kode barang", type: "text", maxlength: 40, value: product?.code || "", readonly: Boolean(product?.is_import), help: product?.is_import ? "Kode barang impor dikunci oleh sistem." : "Huruf/angka; kosongkan untuk otomatis." },
      { name: "unit", label: "Satuan", type: "select", options: unitOptions, required: true, value: product?.unit || "BATANG" },
      { name: "purchase_price", label: "Harga beli acuan / m³", type: "number", min: 0, step: "any", value: product?.purchase_price ?? 0 },
      { name: "min_stock", label: "Stok minimum", type: "number", min: 0, step: "any", value: product?.min_stock ?? 0 },
      { name: "active_price", label: "Harga aktif / m³", type: "select", options: priceChoices, value: activePrice, help: "Dipakai sebagai saran harga saat penerimaan." },
      { name: "spec_t", label: "Tebal default (T, mm)", type: "select", options: specChoices("T"), placeholder: "Tidak ditentukan", value: product?.spec_t ?? "" },
      { name: "spec_l", label: "Lebar default (L, cm)", type: "select", options: specChoices("L"), placeholder: "Tidak ditentukan", value: product?.spec_l ?? "" },
      { name: "spec_p", label: "Panjang default (P, cm)", type: "select", options: specChoices("P"), placeholder: "Tidak ditentukan", value: product?.spec_p ?? "" },
    ],
    submitLabel: product ? "Simpan perubahan" : "Tambah barang",
    submitIcon: product ? "save" : "plus",
    onSubmit: async (values) => {
      const payload = {
        ...values,
        purchase_price: numberOrZero(values.purchase_price),
        min_stock: numberOrZero(values.min_stock),
        active_price: numberOrZero(values.active_price),
      };
      if (product) await api.put(`/api/master/products/${product.id}`, payload);
      else await api.post("/api/master/products", payload);
      toast.success(product ? "Barang diperbarui." : "Barang ditambahkan.");
      await refreshAllMeta();
      await loadSection();
    },
  });
}

async function toggleProduct(product) {
  const result = await confirmDialog({
    title: `${product.active ? "Nonaktifkan" : "Aktifkan"} barang?`,
    message: product.active
      ? "Barang nonaktif tidak muncul pada formulir penerimaan baru, tetapi riwayat stoknya tetap tersimpan."
      : "Barang akan kembali tersedia pada formulir penerimaan.",
    details: `<strong>${esc(product.code)}</strong> · ${esc(product.name)}`,
    confirmLabel: product.active ? "Nonaktifkan" : "Aktifkan",
    danger: product.active,
    iconName: product.active ? "eyeOff" : "eye",
  });
  if (!result.confirmed) return;
  try {
    await api.post(`/api/master/products/${product.id}/toggle`, {});
    toast.success("Status barang diperbarui.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ sellers */

function renderSellers() {
  const rows = state.data || [];
  const cards = rows.length
    ? rows.map((seller) => `<div class="user-card ${seller.active ? "" : "is-inactive"}" data-row data-context-edit="[data-action=edit-seller][data-id='${seller.id}']" data-context-delete="[data-action=delete-seller][data-id='${seller.id}']">
        <div class="avatar">${esc(initials(seller.name))}</div>
        <div class="user-copy-main">
          <div class="user-name-line">
            <strong>${esc(seller.name)}</strong>
            ${seller.active ? badge("Aktif", "green") : badge("Nonaktif", "neutral")}
            ${seller.city ? `<span class="user-handle">${esc(seller.city)}</span>` : ""}
          </div>
          <div class="user-meta">
            ${seller.phone ? `<span>${icon("user", 11)} ${esc(seller.phone)}</span>` : ""}
            ${seller.address ? `<span>${icon("mapPin", 11)} ${esc(seller.address)}</span>` : ""}
            <span>${icon("layers", 11)} ${esc(fmtQty(seller.rit_count))} rit</span>
            <span>${icon("history", 11)} ${esc(fmtQty(seller.transaction_count))} transaksi</span>
          </div>
        </div>
        <div class="user-actions">
          <button class="icon-btn" type="button" title="Ubah penjual" data-action="edit-seller" data-id="${seller.id}">${icon("edit", 16)}</button>
          ${canStatus() ? `<button class="icon-btn" type="button" title="${seller.active ? "Nonaktifkan" : "Aktifkan"} penjual" data-action="toggle-seller" data-id="${seller.id}">${icon(seller.active ? "eyeOff" : "eye", 16)}</button>` : ""}
          <button class="icon-btn" type="button" title="Hapus penjual" data-action="delete-seller" data-id="${seller.id}">${icon("trash", 16)}</button>
        </div>
      </div>`).join("")
    : `<div class="card">${emptyState({ iconName: "users", title: "Belum ada penjual", text: "Tambahkan penjual untuk membuka alur penerimaan lokal." })}</div>`;
  return `${sectionHead("Penjual", "Pemasok kayu yang tercatat beserta jumlah rit dan transaksinya.", `${rows.length} penjual`,
    `<button class="btn btn-primary btn-sm" type="button" data-action="add-seller">${icon("plus", 15)} Tambah penjual</button>`)}
    <div class="filters" style="padding:11px 13px">
      <div class="field grow-field"><label class="field-label">Cari penjual</label><input class="input" type="search" data-master-search placeholder="Nama, kota, atau telepon…" value="${esc(state.search)}"></div>
    </div>
    <div class="user-grid">${cards}</div>`;
}

function openSellerForm(seller = null) {
  openForm({
    title: seller ? "Ubah penjual" : "Tambah penjual",
    eyebrow: "Data master · penjual",
    subtitle: "Nama penjual harus unik agar nota tidak tertukar.",
    fields: [
      { name: "name", label: "Nama penjual", type: "text", required: true, maxlength: 120, value: seller?.name || "", full: true },
      { name: "city", label: "Kota", type: "text", maxlength: 80, value: seller?.city || "" },
      { name: "phone", label: "Telepon", type: "text", maxlength: 40, value: seller?.phone || "" },
      { name: "address", label: "Alamat", type: "text", maxlength: 240, value: seller?.address || "", full: true },
      { name: "note", label: "Catatan", type: "textarea", rows: 3, maxlength: 240, value: seller?.note || "", full: true },
    ],
    submitLabel: seller ? "Simpan perubahan" : "Tambah penjual",
    submitIcon: seller ? "save" : "plus",
    onSubmit: async (values) => {
      if (seller) await api.put(`/api/master/sellers/${seller.id}`, values);
      else await api.post("/api/master/sellers", values);
      toast.success(seller ? "Penjual diperbarui." : "Penjual ditambahkan.");
      await refreshAllMeta();
      await loadSection();
    },
  });
}

async function toggleSeller(seller) {
  const result = await confirmDialog({
    title: `${seller.active ? "Nonaktifkan" : "Aktifkan"} penjual?`,
    message: seller.active
      ? "Penjual nonaktif tidak dapat dipilih untuk rit baru; riwayat tetap utuh."
      : "Penjual akan kembali tersedia pada formulir penerimaan.",
    details: `<strong>${esc(seller.name)}</strong>${seller.city ? ` · ${esc(seller.city)}` : ""}`,
    confirmLabel: seller.active ? "Nonaktifkan" : "Aktifkan",
    danger: seller.active,
    iconName: seller.active ? "eyeOff" : "eye",
  });
  if (!result.confirmed) return;
  try {
    await api.post(`/api/master/sellers/${seller.id}/toggle`, {});
    toast.success("Status penjual diperbarui.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

async function deleteSeller(seller) {
  const result = await confirmDialog({
    title: "Hapus penjual?",
    message: "Penghapusan hanya berhasil bila penjual belum memiliki rit atau transaksi. Bila sudah dipakai, nonaktifkan saja agar jejak audit tetap utuh.",
    details: `<strong>${esc(seller.name)}</strong><br>${esc(fmtQty(seller.rit_count))} rit · ${esc(fmtQty(seller.transaction_count))} transaksi`,
    confirmLabel: "Hapus penjual",
    danger: true,
    iconName: "trash",
  });
  if (!result.confirmed) return;
  try {
    await api.del(`/api/master/sellers/${seller.id}`);
    toast.success("Penjual dihapus.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ locations */

function renderLocations() {
  const rows = state.data || [];
  const tableRows = rows.length
    ? rows.map((location) => `<tr data-row data-context-edit="[data-action=edit-location][data-id='${location.id}']" data-context-delete="[data-action=delete-location][data-id='${location.id}']" class="${location.active ? "" : "is-muted"}">
        <td><span class="code-chip">${esc(location.code)}</span></td>
        <td class="cell-title">${esc(location.name)}</td>
        <td class="num">${esc(fmtQty(location.used))}</td>
        <td>${location.active ? badge("Aktif", "green") : badge("Nonaktif", "neutral")}</td>
        <td>
          <div class="master-table-actions">
            <button class="icon-btn" type="button" title="Ubah lokasi" data-action="edit-location" data-id="${location.id}">${icon("edit", 15)}</button>
            ${canStatus() ? `<button class="icon-btn" type="button" title="${location.active ? "Nonaktifkan" : "Aktifkan"} lokasi" data-action="toggle-location" data-id="${location.id}">${icon(location.active ? "eyeOff" : "eye", 15)}</button>` : ""}
            <button class="icon-btn" type="button" title="Hapus lokasi" data-action="delete-location" data-id="${location.id}">${icon("trash", 15)}</button>
          </div>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="padding:0"><div class="empty-state" style="padding:36px 16px"><span class="empty-icon">${icon("mapPin", 24)}</span><strong>Belum ada lokasi</strong><p>Tambahkan gudang atau area penyimpanan.</p></div></td></tr>`;
  return `${sectionHead("Lokasi penyimpanan", "Kode lokasi dipakai pada transaksi, mutasi, dan opname.", `${rows.length} lokasi`,
    `<button class="btn btn-primary btn-sm" type="button" data-action="add-location">${icon("plus", 15)} Tambah lokasi</button>`)}
    <div class="card card-flush"><div class="table-wrap"><table class="table">
      <thead><tr><th>Kode</th><th>Nama</th><th class="num">Dipakai</th><th>Status</th><th></th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div></div>
    <p class="field-help" style="margin-top:10px">Kode lokasi tidak dapat diubah atau dihapus bila sudah dipakai transaksi, mutasi, atau opname.</p>`;
}

function openLocationForm(location = null) {
  openForm({
    title: location ? "Ubah lokasi" : "Tambah lokasi",
    eyebrow: "Data master · lokasi",
    subtitle: "Gunakan kode pendek yang mudah dikenali, misalnya GUDANG-A atau LOS-1.",
    fields: [
      { name: "code", label: "Kode lokasi", type: "text", required: true, maxlength: 30, value: location?.code || "", help: "Huruf/angka; otomatis diubah ke huruf kapital." },
      { name: "name", label: "Nama lokasi", type: "text", required: true, maxlength: 80, value: location?.name || location?.code || "" },
    ],
    submitLabel: location ? "Simpan perubahan" : "Tambah lokasi",
    submitIcon: location ? "save" : "plus",
    onSubmit: async (values) => {
      if (location) await api.put(`/api/master/locations/${location.id}`, values);
      else await api.post("/api/master/locations", values);
      toast.success(location ? "Lokasi diperbarui." : "Lokasi ditambahkan.");
      await refreshAllMeta();
      await loadSection();
    },
  });
}

async function toggleLocation(location) {
  const result = await confirmDialog({
    title: `${location.active ? "Nonaktifkan" : "Aktifkan"} lokasi?`,
    message: location.active
      ? "Lokasi nonaktif tidak muncul pada pilihan baru, tetapi saldo dan riwayatnya tetap tersedia."
      : "Lokasi akan tersedia kembali pada seluruh formulir.",
    details: `<strong>${esc(location.code)}</strong> · ${esc(location.name)}`,
    confirmLabel: location.active ? "Nonaktifkan" : "Aktifkan",
    danger: location.active,
    iconName: location.active ? "eyeOff" : "eye",
  });
  if (!result.confirmed) return;
  try {
    await api.post(`/api/master/locations/${location.id}/toggle`, {});
    toast.success("Status lokasi diperbarui.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

async function deleteLocation(location) {
  const result = await confirmDialog({
    title: "Hapus lokasi?",
    message: "Lokasi hanya dapat dihapus bila belum pernah dipakai. Bila sudah dipakai, nonaktifkan agar jejak audit tetap utuh.",
    details: `<strong>${esc(location.code)}</strong> · ${esc(location.name)}<br>${esc(fmtQty(location.used))} data terkait`,
    confirmLabel: "Hapus lokasi",
    danger: true,
    iconName: "trash",
  });
  if (!result.confirmed) return;
  try {
    await api.del(`/api/master/locations/${location.id}`);
    toast.success("Lokasi dihapus.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ specs */

function renderSpecs() {
  const data = state.data || {};
  const dimensions = [
    { key: "T", label: "Tebal", unit: "mm" },
    { key: "L", label: "Lebar", unit: "cm" },
    { key: "P", label: "Panjang", unit: "cm" },
  ];
  const cards = dimensions.map((dimension) => {
    const rows = data[dimension.key] || [];
    const list = rows.length
      ? rows.map((spec) => `<div class="spec-row ${spec.active ? "" : "is-inactive"}" data-row data-context-edit="[data-action=edit-spec][data-id='${spec.id}']">
          <span class="spec-value">${esc(Number(spec.value))} <small style="color:var(--muted)">${esc(dimension.unit)}</small></span>
          <div class="row-actions">
            <button class="icon-btn" type="button" title="Ubah nilai" data-action="edit-spec" data-id="${spec.id}" data-dimension="${dimension.key}">${icon("edit", 14)}</button>
            ${canStatus() ? `<button class="icon-btn" type="button" title="${spec.active ? "Nonaktifkan" : "Aktifkan"} nilai" data-action="toggle-spec" data-id="${spec.id}">${icon(spec.active ? "eyeOff" : "eye", 14)}</button>` : ""}
          </div>
        </div>`).join("")
      : `<div class="empty-state" style="padding:22px 10px"><span class="empty-icon">${icon("sliders", 20)}</span><strong>Belum ada nilai</strong></div>`;
    return `<section class="spec-card">
      <div class="spec-head"><strong><span class="spec-dim">${dimension.key}</span>${dimension.label} (${dimension.unit})</strong>
        <button class="icon-btn" type="button" title="Tambah nilai ${esc(dimension.label.toLowerCase())}" data-action="add-spec" data-dimension="${dimension.key}">${icon("plus", 15)}</button>
      </div>
      <div class="spec-list">${list}</div>
    </section>`;
  }).join("");
  const total = dimensions.reduce((sum, dimension) => sum + (data[dimension.key] || []).length, 0);
  return `${sectionHead("Master ukuran", "Nilai yang boleh dipilih pada formulir penerimaan dan opname. Nilai nonaktif tidak dapat dipakai.", `${total} nilai`,
    `<button class="btn btn-primary btn-sm" type="button" data-action="add-spec" data-dimension="T">${icon("plus", 15)} Tambah ukuran</button>`)}
    <div class="spec-grid">${cards}</div>
    <p class="field-help" style="margin-top:10px">Satuan: T = tebal (mm), L = lebar (cm), P = panjang (cm). Rumus volume tetap L × T × P × qty ÷ 10.000.000.</p>`;
}

function specDimensionLabel(key) {
  return { T: "Tebal (mm)", L: "Lebar (cm)", P: "Panjang (cm)" }[key] || key;
}

function openSpecForm(dimension, spec = null) {
  openForm({
    title: spec ? "Ubah nilai ukuran" : "Tambah nilai ukuran",
    eyebrow: "Data master · ukuran",
    subtitle: "Nilai harus unik pada dimensinya. Gunakan angka desimal bila perlu.",
    fields: [
      { name: "dimension_display", label: "Dimensi", type: "static", value: specDimensionLabel(dimension) },
      { name: "value", label: "Nilai", type: "number", required: true, min: 0.01, step: "any", value: spec ? spec.value : "", autofocus: true },
    ],
    submitLabel: spec ? "Simpan nilai" : "Tambah nilai",
    submitIcon: spec ? "save" : "plus",
    onSubmit: async (values) => {
      if (spec) await api.put(`/api/master/specs/${spec.id}`, { value: values.value });
      else await api.post("/api/master/specs", { dimension, value: values.value });
      toast.success(spec ? "Nilai ukuran diperbarui." : "Nilai ukuran ditambahkan.");
      await refreshAllMeta();
      await loadSection();
    },
  });
}

async function toggleSpec(spec) {
  const result = await confirmDialog({
    title: `${spec.active ? "Nonaktifkan" : "Aktifkan"} nilai ukuran?`,
    message: spec.active
      ? "Nilai nonaktif tidak dapat dipilih pada transaksi baru. Data lama tidak terpengaruh."
      : "Nilai akan tersedia kembali pada formulir.",
    details: `<strong>${esc(spec.dimension)} = ${esc(Number(spec.value))}</strong>`,
    confirmLabel: spec.active ? "Nonaktifkan" : "Aktifkan",
    danger: spec.active,
    iconName: spec.active ? "eyeOff" : "eye",
  });
  if (!result.confirmed) return;
  try {
    await api.post(`/api/master/specs/${spec.id}/toggle`, {});
    toast.success("Status ukuran diperbarui.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ prices */

function renderPrices() {
  const rows = state.data || [];
  const list = rows.length
    ? rows.map((price) => `<div class="price-row ${price.active ? "" : "is-inactive"}" data-row data-context-edit="[data-action=edit-price][data-id='${price.id}']" data-context-delete="[data-action=delete-price][data-id='${price.id}']">
        <div>
          <div class="price-num">${esc(fmtMoney(price.price))}</div>
          <div class="cell-sub">per meter kubik</div>
        </div>
        ${price.active ? badge("Aktif", "green") : badge("Nonaktif", "neutral")}
        <div class="row-actions">
          <button class="icon-btn" type="button" title="Ubah harga" data-action="edit-price" data-id="${price.id}">${icon("edit", 15)}</button>
          ${canStatus() ? `<button class="icon-btn" type="button" title="${price.active ? "Nonaktifkan" : "Aktifkan"} harga" data-action="toggle-price" data-id="${price.id}">${icon(price.active ? "eyeOff" : "eye", 15)}</button>` : ""}
          <button class="icon-btn" type="button" title="Hapus harga" data-action="delete-price" data-id="${price.id}">${icon("trash", 15)}</button>
        </div>
      </div>`).join("")
    : `<div class="empty-state" style="padding:36px 16px"><span class="empty-icon">${icon("tag", 24)}</span><strong>Belum ada harga acuan</strong><p>Tambahkan harga per meter kubik yang biasa dipakai.</p></div>`;
  return `${sectionHead("Master harga", "Daftar harga acuan per m³ yang dapat dipilih saat penerimaan dan pengaturan barang.", `${rows.length} harga`,
    `<button class="btn btn-primary btn-sm" type="button" data-action="add-price">${icon("plus", 15)} Tambah harga</button>`)}
    <div class="card card-flush">${list}</div>
    <p class="field-help" style="margin-top:10px">Harga transaksi tetap tersimpan pada nota masing-masing; master harga hanya menyediakan pilihan.</p>`;
}

function openPriceForm(price = null) {
  openForm({
    title: price ? "Ubah harga acuan" : "Tambah harga acuan",
    eyebrow: "Data master · harga",
    subtitle: "Masukkan nilai rupiah per meter kubik.",
    fields: [
      { name: "price", label: "Harga per m³ (Rp)", type: "number", required: true, min: 0.01, step: "any", value: price ? price.price : "", autofocus: true, full: true },
    ],
    submitLabel: price ? "Simpan harga" : "Tambah harga",
    submitIcon: price ? "save" : "plus",
    onSubmit: async (values) => {
      if (price) await api.put(`/api/master/prices/${price.id}`, { price: values.price });
      else await api.post("/api/master/prices", { price: values.price });
      toast.success(price ? "Harga diperbarui." : "Harga ditambahkan.");
      await refreshAllMeta();
      await loadSection();
    },
  });
}

async function togglePrice(price) {
  const result = await confirmDialog({
    title: `${price.active ? "Nonaktifkan" : "Aktifkan"} harga acuan?`,
    message: price.active
      ? "Harga tidak akan muncul sebagai pilihan baru. Barang yang memakai harga ini perlu diperbarui."
      : "Harga akan tersedia kembali pada pilihan formulir.",
    details: `<strong>${esc(fmtMoney(price.price))}</strong> per m³`,
    confirmLabel: price.active ? "Nonaktifkan" : "Aktifkan",
    danger: price.active,
    iconName: price.active ? "eyeOff" : "eye",
  });
  if (!result.confirmed) return;
  try {
    await api.post(`/api/master/prices/${price.id}/toggle`, {});
    toast.success("Status harga diperbarui.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

async function deletePrice(price) {
  const result = await confirmDialog({
    title: "Hapus harga acuan?",
    message: "Harga hanya dapat dihapus bila tidak dipakai sebagai harga aktif barang. Harga pada nota yang sudah tercatat tidak berubah. Bila ragu, nonaktifkan saja.",
    details: `<strong>${esc(fmtMoney(price.price))}</strong> per m³`,
    confirmLabel: "Hapus harga",
    danger: true,
    iconName: "trash",
  });
  if (!result.confirmed) return;
  try {
    await api.del(`/api/master/prices/${price.id}`);
    toast.success("Harga dihapus.");
    await refreshAllMeta();
    await loadSection();
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ events */

function sectionHTML() {
  if (state.section === "products") return renderProducts();
  if (state.section === "sellers") return renderSellers();
  if (state.section === "locations") return renderLocations();
  if (state.section === "specs") return renderSpecs();
  return renderPrices();
}

function findRow(collection, id) {
  return (collection || []).find((row) => Number(row.id) === Number(id));
}

async function handleAction(action, target) {
  const id = target.dataset.id;
  const dimension = target.dataset.dimension;
  if (action === "add-product") return openProductForm();
  if (action === "edit-product") return openProductForm(findRow(state.data, id));
  if (action === "toggle-product") return toggleProduct(findRow(state.data, id));
  if (action === "add-seller") return openSellerForm();
  if (action === "edit-seller") return openSellerForm(findRow(state.data, id));
  if (action === "toggle-seller") return toggleSeller(findRow(state.data, id));
  if (action === "delete-seller") return deleteSeller(findRow(state.data, id));
  if (action === "add-location") return openLocationForm();
  if (action === "edit-location") return openLocationForm(findRow(state.data, id));
  if (action === "toggle-location") return toggleLocation(findRow(state.data, id));
  if (action === "delete-location") return deleteLocation(findRow(state.data, id));
  if (action === "add-spec") return openSpecForm(dimension);
  if (action === "edit-spec") {
    const spec = findRow((state.data || {})[dimension], id);
    return spec ? openSpecForm(spec.dimension, spec) : undefined;
  }
  if (action === "toggle-spec") {
    const spec = Object.values(state.data || {}).flat().find((row) => Number(row.id) === Number(id));
    return spec ? toggleSpec(spec) : undefined;
  }
  if (action === "add-price") return openPriceForm();
  if (action === "edit-price") return openPriceForm(findRow(state.data, id));
  if (action === "toggle-price") return togglePrice(findRow(state.data, id));
  if (action === "delete-price") return deletePrice(findRow(state.data, id));
  return undefined;
}

function applySearch() {
  if (!state.main?.querySelector("[data-master-search]")) return;
  const term = state.search.trim().toLowerCase();
  const rows = state.main?.querySelectorAll("[data-row]") || [];
  let visible = 0;
  rows.forEach((row) => {
    const show = !term || row.textContent.toLowerCase().includes(term);
    row.hidden = !show;
    if (show) visible += 1;
  });
  const count = state.main?.querySelector("#master-count");
  if (count) {
    const total = Array.isArray(state.data)
      ? state.data.length
      : Object.values(state.data || {}).reduce((sum, rows) => sum + rows.length, 0);
    count.textContent = `${visible} / ${total} data`;
  }
}

function bindMain() {
  const main = state.main;
  if (!main) return;
  main.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    handleAction(target.dataset.action, target);
  });
  main.addEventListener("input", (event) => {
    if (!event.target.matches("[data-master-search]")) return;
    state.search = event.target.value;
    applySearch();
  });
}

export async function render(root, { route } = {}) {
  state.root = root;
  state.search = "";
  state.data = null;
  state.seq += 1;
  const requested = route?.segment?.[1];
  state.section = SECTIONS.some((section) => section.key === requested) ? requested : "products";
  if (!requested) {
    history.replaceState(null, "", "#/master/products");
  }
  root.innerHTML = `${pageHeadHTML()}
    <div class="master-layout">
      ${navHTML()}
      <div class="master-main" id="master-main"></div>
    </div>`;
  state.main = root.querySelector("#master-main");
  bindMain();
  root.querySelector("[data-refresh-master]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshAllMeta();
      await loadSection();
      toast.success("Data master disegarkan.");
    } finally {
      button.disabled = false;
    }
  });
  await loadSection();
  return () => {
    state.seq += 1;
    state.root = null;
    state.main = null;
  };
}
