import { api } from "../api.js";
import { icon } from "../icons.js";
import { state as appState } from "../state.js";
import {
  badge, closeAllLayers, confirmDialog, esc, fmtDate, fmtM3, fmtMoney, fmtQty,
  monthISO, openDrawer, openForm, openModal, setBusy, statusBadge, toast, todayISO,
} from "../ui.js";
import {
  locations, pageHead, priceOptions, products, refreshAllMeta, specsFor,
} from "./common.js";

const state = {
  sellers: [],
  sellerId: null,
  sellerQuery: "",
  month: monthISO(),
  rits: [],
  ritId: null,
  notes: [],
  detail: null,
};

function initials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function monthLabel(value) {
  const [year, month] = String(value || "").split("-");
  if (!year || !month) return "-";
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
}

function currentSeller() {
  return state.sellers.find((row) => Number(row.id) === Number(state.sellerId)) || null;
}

function currentRit() {
  return state.rits.find((row) => Number(row.id) === Number(state.ritId)) || null;
}

function layout() {
  return `${pageHead({
    eyebrow: "Penerimaan lokal",
    title: "Penerimaan Lokal",
    subtitle: "Urutannya: pilih penjual → tambah rit → catat nota dan baris kayu yang masuk. Nota selalu berada di dalam rit.",
    actions: `<button class="btn btn-secondary" type="button" data-refresh>${icon("refresh", 16)} Muat ulang</button>
      <button class="btn btn-primary" type="button" data-new-rit>${icon("plus", 16)} Rit baru</button>`,
  })}
  <div class="receiving-top">
    <div class="toolbar-row">
      <div class="field"><label class="field-label" for="recv-month">Bulan rit</label><input class="input" id="recv-month" type="month" value="${esc(state.month)}" style="min-width:160px"></div>
      <div class="inline-meta" style="padding-bottom:9px">
        <span>${icon("users", 13)} <strong id="seller-total">0</strong> penjual</span>
        <span>${icon("inbox", 13)} <strong id="rit-total">0</strong> rit</span>
        <span>${icon("receipt", 13)} <strong id="note-total">0</strong> nota</span>
      </div>
    </div>
    <div class="inline-meta" style="padding-bottom:9px">
      <span>${icon("calendar", 13)} ${esc(monthLabel(state.month))}</span>
      <span>${icon("lock", 13)} terkunci s.d. <strong>${esc(metaLock())}</strong></span>
    </div>
  </div>
  <div class="workspace">
    <section class="ws-col" aria-label="Daftar penjual">
      <div class="ws-head"><h2><span class="ws-step">1</span> Penjual</h2><span class="count" id="seller-count">0</span></div>
      <div class="seller-search"><input class="input" type="search" id="seller-search" placeholder="Cari penjual atau kota…" autocomplete="off"></div>
      <div class="ws-scroll" id="seller-list"><div class="ws-empty">Memuat penjual…</div></div>
    </section>
    <section class="ws-col" aria-label="Daftar rit">
      <div class="ws-head">
        <h2><span class="ws-step">2</span> Rit <span class="count" id="rit-count">0</span></h2>
        <button class="btn btn-primary btn-sm" type="button" id="rit-add-btn" data-new-rit disabled title="Pilih penjual terlebih dahulu">${icon("plus", 15)} Rit</button>
      </div>
      <div class="ws-toolbar">
        <input class="input" type="search" id="rit-search" placeholder="Cari nomor / surat jalan…" autocomplete="off">
      </div>
      <div class="ws-scroll" id="rit-list"><div class="ws-empty">${icon("inbox", 24)}Pilih penjual terlebih dahulu.</div></div>
    </section>
    <section class="ws-col" aria-label="Nota penerimaan">
      <div class="ws-head">
        <div>
          <h2><span class="ws-step">3</span> Nota</h2>
          <span class="inline-meta" id="note-head-sub" style="font-size:9.5px;margin-top:2px">Pilih rit untuk melihat nota</span>
        </div>
        <div class="toolbar-row" id="note-head-actions"></div>
      </div>
      <div class="ws-scroll" id="note-list"><div class="ws-empty workspace-main-empty">${icon("receipt", 28)}<br>Pilih rit di kolom kedua, lalu kelola nota dan baris penerimaan di sini.</div></div>
    </section>
  </div>`;
}

function metaLock() {
  return appState.meta?.lock?.locked_through_display || "belum dikunci";
}

async function loadSellers() {
  const data = await api.get("/api/sellers/directory");
  state.sellers = (data.sellers || []).filter((row) => row.active !== 0 && row.active !== false);
  if (!state.sellers.length) state.sellerId = null;
  else if (!state.sellers.some((row) => Number(row.id) === Number(state.sellerId))) state.sellerId = Number(state.sellers[0].id);
  renderSellers();
}

function filteredSellers() {
  const term = state.sellerQuery.trim().toLowerCase();
  if (!term) return state.sellers;
  return state.sellers.filter((row) => `${row.name} ${row.city || ""}`.toLowerCase().includes(term));
}

function renderSellers() {
  const list = document.getElementById("seller-list");
  if (!list) return;
  const rows = filteredSellers();
  document.getElementById("seller-total").textContent = fmtQty(state.sellers.length);
  document.getElementById("seller-count").textContent = rows.length;
  if (!rows.length) {
    list.innerHTML = `<div class="ws-empty">${icon("search", 23)}Tidak ada penjual yang cocok.</div>`;
    return;
  }
  list.innerHTML = rows.map((row) => `<button class="seller-item ${Number(row.id) === Number(state.sellerId) ? "is-active" : ""}" type="button" data-seller="${row.id}">
    <span class="seller-avatar">${esc(initials(row.name))}</span>
    <span class="seller-copy"><strong>${esc(row.name)}</strong><span>${esc(row.city || "Tanpa kota")}</span></span>
    <span class="seller-meta"><b>${esc(fmtQty(row.rit_count))}</b><small>rit</small></span>
  </button>`).join("");
}

async function selectSeller(sellerId) {
  state.sellerId = Number(sellerId);
  state.ritId = null;
  state.rits = [];
  state.notes = [];
  renderSellers();
  renderRits();
  renderNotes();
  await loadRits();
}

function filteredRits() {
  return state.rits;
}

async function loadRits() {
  if (!state.sellerId) {
    state.rits = [];
    state.ritId = null;
    renderRits();
    renderNotes();
    return;
  }
  const list = document.getElementById("rit-list");
  if (list) list.innerHTML = `<div class="ws-empty"><span class="spinner"></span></div>`;
  try {
    const data = await api.get(`/api/rits`, { seller_id: state.sellerId, month: state.month });
    state.rits = data.rits || [];
    if (!state.rits.some((row) => Number(row.id) === Number(state.ritId))) {
      state.ritId = state.rits.length ? Number(state.rits[0].id) : null;
    }
    renderRits();
    await loadNotes();
  } catch (error) {
    if (list) list.innerHTML = `<div class="ws-empty">${esc(error.message)}</div>`;
  }
}

/* Tombol-tombol kolom Rit/Nota mengikuti urutan kerja: rit dulu, baru nota. */
function syncActionButtons() {
  const ritBtn = document.getElementById("rit-add-btn");
  if (ritBtn) {
    ritBtn.disabled = !state.sellerId;
    ritBtn.title = state.sellerId ? "Tambah rit baru untuk penjual ini" : "Pilih penjual terlebih dahulu";
  }
  const actions = document.getElementById("note-head-actions");
  if (!actions) return;
  const rit = currentRit();
  if (!rit) {
    actions.innerHTML = `<button class="btn btn-primary btn-sm" type="button" data-add-note ${state.sellerId ? "" : "disabled"} title="Nota ada di dalam rit — buat rit dahulu">${icon("plus", 15)} Nota</button>`;
    return;
  }
  actions.innerHTML = `
      <button class="icon-btn" type="button" data-edit-rit title="Ubah rit">${icon("edit", 16)}</button>
      <button class="icon-btn" type="button" data-delete-rit title="Hapus rit">${icon("trash", 16)}</button>
      <button class="btn btn-primary btn-sm" type="button" data-add-note ${rit.is_locked ? "disabled" : ""}>${icon("plus", 15)} Nota</button>`;
}

function renderRits() {
  syncActionButtons();
  const list = document.getElementById("rit-list");
  if (!list) return;
  document.getElementById("rit-total").textContent = fmtQty(state.rits.length);
  document.getElementById("rit-count").textContent = state.rits.length;
  if (!state.rits.length) {
    list.innerHTML = `<div class="ws-empty">${icon("inbox", 24)}Belum ada rit pada bulan ini.<br><button class="btn btn-primary btn-sm" type="button" data-new-rit style="margin-top:9px">${icon("plus", 14)} Tambah rit pertama</button></div>`;
    return;
  }
  list.innerHTML = state.rits.map((row) => `<button class="rit-card ${Number(row.id) === Number(state.ritId) ? "is-active" : ""}" type="button" data-rit="${row.id}" data-context-edit="[data-edit-rit]" data-context-delete="[data-delete-rit]">
    <span class="rit-card-top">
      <span class="rit-no"><span class="num-badge">${esc(row.rit_number_display)}</span> Rit</span>
      <span class="rit-date">${esc(fmtDate(row.rit_date))}</span>
    </span>
    <span class="rit-delivery">SJ ${esc(row.delivery_number || "-")}</span>
    <span class="rit-stats"><span><b>${esc(fmtQty(row.notes_count))}</b> nota</span><span><b>${esc(fmtQty(row.qty))}</b> batang</span><span><b>${esc(fmtM3(row.volume))}</b> m³</span></span>
    ${row.is_locked ? `<span class="lock-tag">${icon("lock", 10)} periode terkunci</span>` : ""}
  </button>`).join("");
}

async function selectRit(ritId) {
  state.ritId = Number(ritId);
  renderRits();
  await loadNotes();
}

async function loadNotes() {
  const list = document.getElementById("note-list");
  const sub = document.getElementById("note-head-sub");
  const actions = document.getElementById("note-head-actions");
  const rit = currentRit();
  syncActionButtons();
  if (!state.ritId) {
    state.notes = [];
    if (list) {
      list.innerHTML = state.sellerId
        ? `<div class="ws-empty workspace-main-empty">${icon("receipt", 28)}<br>Nota dicatat di dalam rit.<br>Buat rit dahulu, lalu nota bisa ditambahkan.<br><button class="btn btn-primary btn-sm" type="button" data-new-rit style="margin-top:10px">${icon("plus", 14)} Tambah rit</button></div>`
        : `<div class="ws-empty workspace-main-empty">${icon("receipt", 28)}<br>Pilih penjual, lalu pilih atau buat rit.</div>`;
    }
    if (sub) sub.textContent = state.sellerId ? "Belum ada rit dipilih." : "Pilih penjual terlebih dahulu.";
    document.getElementById("note-total").textContent = "0";
    return;
  }
  if (list) list.innerHTML = `<div class="ws-empty"><span class="spinner"></span><span style="display:block;margin-top:7px">Memuat nota…</span></div>`;
  if (sub) {
    sub.innerHTML = rit
      ? `Rit ${esc(rit.rit_number_display)} · SJ ${esc(rit.delivery_number || "-")} · ${esc(fmtDate(rit.rit_date))} ${rit.is_locked ? badge("Terkunci", "amber") : ""}`
      : "";
  }
  try {
    const data = await api.get(`/api/rits/${state.ritId}/notes`);
    state.notes = data.notes || [];
    document.getElementById("note-total").textContent = fmtQty(state.notes.length);
    renderNotes();
  } catch (error) {
    if (list) list.innerHTML = `<div class="ws-empty">${esc(error.message)}</div>`;
  }
}

function renderNotes() {
  const list = document.getElementById("note-list");
  if (!list) return;
  if (!state.notes.length) {
    list.innerHTML = `<div class="ws-empty workspace-main-empty">${icon("receipt", 28)}<br>Rit ini belum memiliki nota.<br><button class="btn btn-primary btn-sm" type="button" data-add-note style="margin-top:10px" ${currentRit()?.is_locked ? "disabled" : ""}>${icon("plus", 14)} Catat nota pertama</button></div>`;
    return;
  }
  list.innerHTML = state.notes.map((note) => `<article class="note-card" data-note-card="${esc(note.note_raw)}">
    <button class="note-main" type="button" data-note="${esc(note.note_raw)}">
      <span class="note-icon">${icon("receipt", 16)}</span>
      <span class="note-copy">
        <span class="note-title-line"><strong>${esc(note.note)}</strong>${note.is_locked ? badge("Terkunci", "amber") : ""}</span>
        <span class="note-sub"><span>${esc(fmtDate(note.date))}</span><span><b>${esc(fmtQty(note.lines_count))}</b> baris</span><span><b>${esc(fmtQty(note.qty))}</b> batang</span><span><b>${esc(fmtM3(note.volume))}</b> m³</span></span>
        <span class="note-flags">
          ${note.has_active_tally ? note.tally_numbers.map((number) => badge(number, "green")).join("") : ""}
          ${note.has_active_recap ? note.recap_numbers.map((number) => badge(number, "blue")).join("") : ""}
          ${note.tallies?.some((row) => row.status === "BATAL") ? badge("Tally batal", "red") : ""}
        </span>
      </span>
      <span class="note-amount"><strong>${esc(fmtMoney(note.amount))}</strong><span>${esc(fmtM3(note.volume))} m³</span></span>
    </button>
    <div class="note-action-row">
      <button class="btn btn-secondary" type="button" data-note="${esc(note.note_raw)}">${icon("eye", 13)} Detail</button>
      <button class="btn btn-secondary" type="button" data-tally="${esc(note.note_raw)}" ${note.has_active_tally ? "disabled" : ""}>${icon("tally", 13)} Tally</button>
      <button class="btn btn-secondary" type="button" data-recap="${esc(note.note_raw)}" ${note.has_active_recap || note.is_locked ? "disabled" : ""}>${icon("receipt", 13)} Rekap</button>
    </div>
  </article>`).join("");
}

/* ------------------------------------------------------------------ forms */

function dimensionOptions(dimension) {
  return specsFor(dimension).map((value) => ({ value, label: value }));
}

function lineFields({ lockNote = false, noteValue = "", detail = null } = {}) {
  const tOptions = dimensionOptions("T");
  const lOptions = dimensionOptions("L");
  const pOptions = dimensionOptions("P");
  const priceOpts = priceOptions();
  const locOpts = locations({ includeEmpty: true });
  const defaultLocation = locOpts.find((row) => row.value)?.value || "";
  const productOpts = products({ includeImport: false });
  const fields = [
    { name: "note", label: "Nomor nota", type: "text", required: true, placeholder: "cth. 001 atau BR-001", value: noteValue, readonly: lockNote, help: lockNote ? "Baris mengikuti nomor nota yang sedang dibuka." : "3–6 digit angka, boleh memakai prefix BR-." },
    { name: "date", label: "Tanggal nota", type: "date", required: true, max: todayISO(), value: detail?.date || todayISO() },
    tOptions.length
      ? { name: "thickness", label: "Tebal (T, mm)", type: "select", required: true, options: tOptions, value: detail?.thickness ?? tOptions[0]?.value, help: "Satuan milimeter." }
      : { name: "thickness", label: "Tebal (T, mm)", type: "number", required: true, step: "0.01", min: 0.01, value: detail?.thickness || "" },
    priceOpts.length
      ? { name: "price", label: "Harga per m³", type: "select", required: true, options: priceOpts, value: detail?.price ?? priceOpts[0]?.value }
      : { name: "price", label: "Harga per m³", type: "number", required: true, min: 1, value: detail?.price || "" },
    { name: "location", label: "Lokasi simpan", type: "select", required: true, options: locOpts, value: detail?.location ?? defaultLocation },
    { name: "product_id", label: "Barang", type: "select", required: true, options: productOpts, value: "", full: true },
    lOptions.length
      ? { name: "width", label: "Lebar (L, cm)", type: "select", required: true, options: lOptions, value: detail?.lines?.[0]?.l ?? lOptions[0]?.value, help: "Satuan sentimeter." }
      : { name: "width", label: "Lebar (L, cm)", type: "number", required: true, step: "0.01", value: "" },
    pOptions.length
      ? { name: "length", label: "Panjang (P, cm)", type: "select", required: true, options: pOptions, value: detail?.lines?.[0]?.p ?? pOptions[0]?.value, help: "Satuan sentimeter." }
      : { name: "length", label: "Panjang (P, cm)", type: "number", required: true, step: "0.01", value: "" },
    { name: "qty", label: "Qty (batang)", type: "number", required: true, min: 0.0001, step: "any", value: 1 },
    { name: "line_note", label: "Catatan baris", type: "text", full: true, maxlength: 300, placeholder: "Opsional" },
  ];
  return fields;
}

function openAddNote({ detail = null, mode = "nota" } = {}) {
  if (!state.sellerId) {
    toast.warn("Pilih penjual terlebih dahulu.");
    return;
  }
  if (!state.ritId) {
    /* Nota selalu berada di dalam rit: tanpa rit terpilih, buka formulir rit. */
    toast.info("Nota dicatat di dalam rit. Buat rit terlebih dahulu.");
    openRitForm();
    return;
  }
  if (currentRit()?.is_locked) {
    toast.warn("Rit berada pada periode terkunci.");
    return;
  }
  if (!products({ includeImport: false }).length) {
    toast.warn("Belum ada barang lokal aktif. Lengkapi Data Master terlebih dahulu.");
    return;
  }
  openForm({
    title: mode === "line" ? "Tambah baris nota" : "Catat nota penerimaan",
    eyebrow: mode === "line" ? "Nota berjalan" : "Penerimaan lokal",
    subtitle: mode === "line" ? `${detail?.note_display || ""} · ${currentRit()?.seller_name || ""}` : `Rit ${currentRit()?.rit_number_display || ""} · ${currentRit()?.seller_name || ""}`,
    fields: lineFields({ lockNote: mode === "line", noteValue: detail?.note || "", detail }),
    values: mode === "line" ? { note: detail?.note || "" } : {},
    submitLabel: mode === "line" ? "Tambah baris" : "Simpan nota",
    submitIcon: "save",
    size: "lg",
    intro: `<div class="inline-meta"><span>${icon("scan", 13)} Baris baru akan menambah stok pada lokasi yang dipilih.</span><span>${icon("lock", 13)} Tanggal tidak boleh melewati hari ini.</span></div>`,
    onSubmit: async (values) => {
      const payload = {
        note: values.note,
        date: values.date,
        thickness: values.thickness,
        price: values.price,
        location: values.location,
        product_id: Number(values.product_id),
        width: values.width,
        length: values.length,
        qty: values.qty,
        line_note: values.line_note || "",
      };
      const result = await api.post(`/api/rits/${state.ritId}/notes`, payload);
      toast.success(mode === "line" ? "Baris nota ditambahkan." : `Nota ${result.note || values.note} tersimpan.`);
      await Promise.all([loadNotes(), reloadRitsQuiet()]);
      refreshAllMeta().catch(() => {});
    },
  });
}

async function reloadRitsQuiet() {
  if (!state.sellerId) return;
  try {
    const data = await api.get(`/api/rits`, { seller_id: state.sellerId, month: state.month });
    state.rits = data.rits || [];
    renderRits();
  } catch {
    /* daftar rit akan dimuat ulang saat dibutuhkan */
  }
}

function openRitForm({ rit = null } = {}) {
  if (!state.sellerId) {
    toast.warn("Pilih penjual terlebih dahulu.");
    return;
  }
  const seller = currentSeller();
  const suggested = state.rits.length ? Math.max(...state.rits.map((row) => Number(row.rit_number) || 0)) + 1 : 1;
  openForm({
    title: rit ? `Ubah rit ${rit.rit_number_display}` : "Rit baru",
    eyebrow: "Penerimaan lokal",
    subtitle: seller ? `${seller.name} — ${seller.city || "tanpa kota"}` : "",
    fields: [
      { name: "rit_number", label: "Nomor rit", type: "number", required: true, min: 1, step: 1, value: rit?.rit_number ?? suggested, help: "Nomor urut rit pada bulan berjalan." },
      { name: "date", label: "Tanggal rit", type: "date", required: true, max: todayISO(), value: rit?.rit_date?.slice(0, 10) || todayISO() },
      { name: "delivery_number", label: "Nomor surat jalan", type: "text", maxlength: 80, value: rit?.delivery_number || "", full: true, placeholder: "Opsional" },
      { name: "note", label: "Catatan rit", type: "textarea", rows: 2, maxlength: 300, full: true, value: rit?.note || "", placeholder: "Opsional" },
    ],
    submitLabel: rit ? "Simpan perubahan" : "Buat rit",
    submitIcon: rit ? "save" : "plus",
    onSubmit: async (values) => {
      if (rit) {
        await api.put(`/api/rits/${rit.id}`, values);
        toast.success("Rit diperbarui.");
        await loadRits();
      } else {
        const result = await api.post("/api/rits", { ...values, seller_id: state.sellerId });
        state.ritId = Number(result.id);
        /* Tampilkan bulan milik rit baru agar langsung terlihat di daftar. */
        const ritMonth = String(values.date || "").slice(0, 7);
        if (ritMonth) {
          state.month = ritMonth;
          const monthInput = document.getElementById("recv-month");
          if (monthInput) monthInput.value = ritMonth;
        }
        await loadRits();
        document.querySelector("[data-rit].is-active")?.scrollIntoView({ block: "nearest" });
        toast.success("Rit baru dibuat. Lanjutkan mencatat nota.");
        /* Alur kerja: rit selesai dibuat → langsung formulir nota pertama. */
        window.setTimeout(() => {
          if (state.ritId === Number(result.id) && !currentRit()?.is_locked) openAddNote();
        }, 400);
      }
      refreshAllMeta().catch(() => {});
    },
  });
}

async function deleteRit() {
  const rit = currentRit();
  if (!rit) return;
  const result = await confirmDialog({
    title: `Hapus rit ${rit.rit_number_display}?`,
    message: "Rit hanya dapat dihapus bila belum memiliki nota atau transaksi.",
    details: `<div class="inline-meta"><span>${icon("calendar", 13)} ${esc(fmtDate(rit.rit_date))}</span><span>${icon("inbox", 13)} SJ ${esc(rit.delivery_number || "-")}</span></div>`,
    confirmLabel: "Hapus rit",
    danger: true,
  });
  if (!result.confirmed) return;
  try {
    await api.del(`/api/rits/${rit.id}`);
    toast.success("Rit dihapus.");
    state.ritId = null;
    await loadRits();
    refreshAllMeta().catch(() => {});
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ note detail */

async function openNoteDetail(noteNumber) {
  const drawer = openDrawer({
    title: "Memuat nota…",
    eyebrow: "Detail nota",
    subtitle: currentRit()?.seller_name || "",
    size: "lg",
    body: `<div class="loading-block"><span class="spinner"></span><span>Mengambil baris nota…</span></div>`,
  });
  try {
    const detail = await api.get(`/api/rits/${state.ritId}/notes/${encodeURIComponent(noteNumber)}`);
    state.detail = detail;
    paintNoteDrawer(drawer, detail);
  } catch (error) {
    drawer.close();
    toast.error(error.message);
  }
}

function paintNoteDrawer(drawer, detail) {
  drawer.rootEl.querySelector(".layer-heading h2").textContent = detail.note_display;
  drawer.rootEl.querySelector(".layer-heading p").textContent = `${detail.rit?.seller_name || ""} · Rit ${String(detail.rit?.rit_number || "").padStart(2, "0")} · SJ ${detail.delivery_number || "-"}`;
  const activeTallies = (detail.tallies || []).filter((row) => row.status === "POSTED");
  const activeRecaps = (detail.recaps || []).filter((row) => row.status === "AKTIF");
  drawer.bodyEl.innerHTML = `
    <div class="status-strip">
      ${detail.lines.some((line) => line.can_edit) ? badge("Baris dapat diubah", "green") : badge("Baris terkunci", "amber")}
      ${activeTallies.length ? badge(`${activeTallies.length} tally aktif`, "green") : ""}
      ${activeRecaps.length ? badge(`${activeRecaps.length} rekap aktif`, "blue") : ""}
      <span class="status-note">${icon("calendar", 12)} ${esc(fmtDate(detail.date))}</span>
    </div>
    <div class="meta-grid">
      <div class="meta-cell"><span>Nota</span><strong>${esc(detail.note_display)}</strong></div>
      <div class="meta-cell"><span>Tanggal</span><strong>${esc(fmtDate(detail.date))}</strong></div>
      <div class="meta-cell"><span>Tebal</span><strong>${esc(detail.thickness)} mm</strong></div>
      <div class="meta-cell"><span>Harga / m³</span><strong>${esc(fmtMoney(detail.price))}</strong></div>
      <div class="meta-cell"><span>Lokasi</span><strong>${esc(detail.location || "Tanpa lokasi")}</strong></div>
      <div class="meta-cell"><span>Surat jalan</span><strong>${esc(detail.delivery_number || "-")}</strong></div>
    </div>
    <div class="table-wrap note-table">
      <table class="table">
        <thead><tr><th>Barang</th><th>Ukuran (T×L×P)</th><th class="num">Qty</th><th class="num">m³</th><th class="num">Jumlah</th><th></th></tr></thead>
        <tbody>
          ${detail.lines.map((line) => `<tr>
            <td><div class="cell-title">${esc(line.name)}</div><div class="cell-sub">${esc(line.code)}${line.note ? ` · ${esc(line.note)}` : ""}</div></td>
            <td><span class="size">${esc(line.size_display)}</span></td>
            <td class="num">${esc(fmtQty(line.qty))}</td>
            <td class="num">${esc(fmtM3(line.volume))}</td>
            <td class="num strong">${esc(fmtMoney(line.amount))}</td>
            <td class="num">${line.can_edit ? `<button class="icon-btn" type="button" data-delete-line="${line.id}" title="Hapus baris">${icon("trash", 15)}</button>` : `<span class="status-note" title="${esc(blockerText(line))}">${icon("lock", 13)}</span>`}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="note-total-row">
      <div class="note-total"><span>Total qty</span><strong>${esc(fmtQty(detail.totals.qty))} batang</strong></div>
      <div class="note-total"><span>Volume</span><strong>${esc(fmtM3(detail.totals.volume))} m³</strong></div>
      <div class="note-total accent"><span>Nilai nota</span><strong>${esc(fmtMoney(detail.totals.amount))}</strong></div>
    </div>
    <div class="section-divider"></div>
    <div class="section-head">
      <div><h2>Dokumen terkait</h2><p>Tally dan rekap pembayaran pada nota ini</p></div>
      <div class="toolbar-row">
        <button class="btn btn-secondary btn-sm" type="button" data-detail-tally ${activeTallies.length ? "disabled" : ""}>${icon("tally", 14)} Tally</button>
        <button class="btn btn-secondary btn-sm" type="button" data-detail-recap ${activeRecaps.length || !canRecap(detail) ? "disabled" : ""}>${icon("receipt", 14)} Rekap</button>
      </div>
    </div>
    <div class="document-list">
      ${[...(detail.tallies || []), ...(detail.recaps || [])].length ? [...(detail.tallies || []).map((row) => documentRow(row, "tally")), ...(detail.recaps || []).map((row) => documentRow(row, "recap"))].join("") : `<div class="ws-empty" style="padding:18px">${icon("file", 22)}Belum ada tally atau rekap pada nota ini.</div>`}
    </div>
    <div class="section-divider"></div>
    <div class="toolbar-row">
      <button class="btn btn-primary btn-sm" type="button" data-add-line ${activeTallies.length || activeRecaps.length ? `disabled title="Nota sudah memiliki dokumen tally/rekap aktif"` : ""}>${icon("plus", 15)} Tambah baris</button>
      <button class="btn btn-secondary btn-sm" type="button" data-edit-note ${detail.lines.some((line) => line.can_edit) ? "" : "disabled"}>${icon("edit", 15)} Ubah nota</button>
      <a class="btn btn-secondary btn-sm" href="#/tally">${icon("list", 15)} Semua tally</a>
      <a class="btn btn-secondary btn-sm" href="#/recap">${icon("list", 15)} Semua rekap</a>
    </div>
  `;
  const body = drawer.bodyEl;
  body.querySelectorAll("[data-delete-line]").forEach((button) => {
    button.addEventListener("click", () => deleteLine(drawer, Number(button.dataset.deleteLine)));
  });
  body.querySelector("[data-add-line]")?.addEventListener("click", () => openAddNote({ detail, mode: "line" }));
  body.querySelector("[data-edit-note]")?.addEventListener("click", () => openEditNote(detail, drawer));
  body.querySelector("[data-detail-tally]")?.addEventListener("click", () => openTallyModal(detail, () => drawer.close()));
  body.querySelector("[data-detail-recap]")?.addEventListener("click", async () => {
    await createRecap(detail.note);
    drawer.close();
  });
  body.querySelectorAll("[data-pdf]").forEach((button) => {
    button.addEventListener("click", () => api.openPdf(button.dataset.pdf));
  });
  body.querySelectorAll("[data-cancel-doc]").forEach((button) => {
    button.addEventListener("click", () => cancelDocument(button.dataset.kind, Number(button.dataset.cancelDoc), drawer));
  });
}

function canRecap(detail) {
  return !detail.lines.some((line) => line.blockers?.recap);
}

function blockerText(line) {
  const parts = [];
  if (line.blockers?.tally) parts.push(`tally ${line.blockers.tally}`);
  if (line.blockers?.recap) parts.push(`rekap ${line.blockers.recap}`);
  if (line.blockers?.outgoing) parts.push(`barang keluar #${line.blockers.outgoing}`);
  return parts.length ? `Terikat ${parts.join(", ")}` : "Baris tidak dapat diubah";
}

function documentRow(row, kind) {
  const isActive = kind === "tally" ? row.status === "POSTED" : row.status === "AKTIF";
  return `<div class="document-row">
    <span class="doc-icon">${icon(kind === "tally" ? "tally" : "receipt", 15)}</span>
    <span class="document-copy">
      <strong>${esc(row.tally_number || row.recap_number)}</strong>
      <span>${esc(kind === "tally" ? "Tally" : "Rekap")} · ${esc(fmtQty(row.total_qty))} batang · ${esc(fmtMoney(row.total_amount))} · ${esc((row.created_at || "").slice(0, 16).replace("T", " "))}</span>
    </span>
    ${statusBadge(row.status)}
    <span class="document-actions">
      <button class="icon-btn" type="button" data-pdf="/api/pdf/${kind}/${row.id}" title="Buka PDF">${icon("printer", 15)}</button>
      ${isActive ? `<button class="icon-btn" type="button" data-kind="${kind}" data-cancel-doc="${row.id}" title="Batalkan">${icon("x", 15)}</button>` : ""}
    </span>
  </div>`;
}

function openEditNote(detail, drawer) {
  openForm({
    title: "Ubah nota",
    eyebrow: "Penerimaan lokal",
    subtitle: `${detail.note_display} · berlaku untuk seluruh baris`,
    fields: [
      { name: "new_note", label: "Nomor nota", type: "text", value: detail.note, help: "Kosongkan untuk mempertahankan nomor saat ini.", placeholder: detail.note },
      { name: "date", label: "Tanggal nota", type: "date", required: true, max: todayISO(), value: detail.date },
      { name: "thickness", label: "Tebal (T, mm)", type: "select", required: true, options: dimensionOptions("T"), value: detail.thickness },
      { name: "price", label: "Harga per m³", type: "select", required: true, options: priceOptions(), value: detail.price },
      { name: "location", label: "Lokasi simpan", type: "select", required: true, options: locations({ includeEmpty: true }), value: detail.location, full: true },
    ],
    submitLabel: "Simpan perubahan",
    submitIcon: "save",
    intro: `<div class="inline-meta"><span>${icon("alert", 13)} Perubahan menyentuh ${esc(detail.lines.length)} baris nota.</span><span>Lokasi baru harus memiliki stok asal yang cukup.</span></div>`,
    onSubmit: async (values) => {
      const result = await api.put(`/api/rits/${state.ritId}/notes/${encodeURIComponent(detail.note)}`, values);
      toast.success("Nota diperbarui.");
      drawer.close();
      await loadNotes();
      if (result.note) window.setTimeout(() => openNoteDetail(result.note), 250);
    },
  });
}

async function deleteLine(drawer, trxId) {
  const result = await confirmDialog({
    title: "Hapus baris nota?",
    message: "Baris akan dihapus dan stok pada lokasi ini berkurang. Tindakan ini tidak dapat dibatalkan.",
    confirmLabel: "Hapus baris",
    danger: true,
  });
  if (!result.confirmed) return;
  try {
    await api.del(`/api/note-lines/${trxId}`);
    toast.success("Baris nota dihapus.");
    drawer.close();
    await Promise.all([loadNotes(), reloadRitsQuiet()]);
    refreshAllMeta().catch(() => {});
    const current = state.notes.find((note) => note.note_raw === state.detail?.note);
    if (current) openNoteDetail(current.note_raw);
  } catch (error) {
    toast.error(error.message);
  }
}

async function createRecap(noteNumber) {
  const result = await confirmDialog({
    title: "Buat rekap pembayaran?",
    message: "Seluruh baris nota akan dikunci ke dalam rekap pembayaran aktif.",
    details: `<div class="inline-meta"><span>${icon("receipt", 13)} Nota ${esc(noteNumber)}</span><span>Aksi ini tercatat di log.</span></div>`,
    confirmLabel: "Buat rekap",
  });
  if (!result.confirmed) return;
  try {
    const recap = await api.post(`/api/rits/${state.ritId}/notes/${encodeURIComponent(noteNumber)}/recap`, {});
    toast.success(`Rekap ${recap.recap_number} dibuat.`);
    await Promise.all([loadNotes(), reloadRitsQuiet()]);
    refreshAllMeta().catch(() => {});
  } catch (error) {
    toast.error(error.message);
  }
}

async function cancelDocument(kind, id, drawer) {
  const label = kind === "tally" ? "tally" : "rekap pembayaran";
  const values = await promptReason({
    title: `Batalkan ${label}?`,
    message: "Dokumen akan berstatus batal dan baris nota dapat diubah kembali.",
    confirmLabel: "Batalkan dokumen",
  });
  if (!values) return;
  try {
    await api.post(`/api/${kind === "tally" ? "tallies" : "recaps"}/${id}/cancel`, { reason: values.reason || "" });
    toast.success(`Dokumen ${label} dibatalkan.`);
    drawer?.close();
    await Promise.all([loadNotes(), reloadRitsQuiet()]);
    refreshAllMeta().catch(() => {});
    if (state.detail?.note) window.setTimeout(() => openNoteDetail(state.detail.note), 200);
  } catch (error) {
    toast.error(error.message);
  }
}

function promptReason({ title, message, confirmLabel = "Lanjutkan" }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      eyebrow: "Pembatalan",
      subtitle: "Tindakan ini tercatat pada log aktivitas.",
      size: "sm",
      iconName: "alert",
      body: `<p class="confirm-message">${esc(message)}</p>
        <form class="form-grid" id="reason-form">
          <div class="field field-full"><label class="field-label" for="cancel-reason">Alasan (opsional)</label>
            <textarea class="input textarea" id="cancel-reason" name="reason" rows="3" maxlength="300" placeholder="Jelaskan alasan pembatalan" autofocus></textarea>
          </div>
        </form>`,
      footer: `<button class="btn btn-ghost" type="button" data-layer-close>Batal</button>
        <button class="btn btn-danger" type="button" data-confirm-reason>${icon("alert", 16)} ${esc(confirmLabel)}</button>`,
      onClose: () => finish(null),
    });
    const submit = () => {
      const reason = modal.rootEl.querySelector("#cancel-reason")?.value.trim() || "";
      finish({ reason });
      modal.close();
    };
    modal.rootEl.querySelector("[data-confirm-reason]")?.addEventListener("click", submit);
    modal.rootEl.querySelector("#reason-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
  });
}

/* ------------------------------------------------------------------ tally */

function lineVolume(line, qty) {
  return (Number(line.l || 0) * Number(line.t || 0) * Number(line.p || 0) * Number(qty || 0)) / 10000000;
}

async function openTallyModal(detail, onDone = null) {
  const eligible = (detail.lines || []).filter((line) => !line.blockers?.tally);
  if (!eligible.length) {
    toast.warn("Semua baris nota sudah memiliki tally aktif.");
    return;
  }
  const rows = eligible.map((line) => `<div class="tally-line" data-line="${line.id}" data-price="${esc(line.price)}" data-t="${esc(line.t)}" data-l="${esc(line.l)}" data-p="${esc(line.p)}">
    <div class="tally-line-head">
      <div><strong>${esc(line.name)}</strong><div class="cell-sub">${esc(line.code)} · ${esc(line.size_display)} · qty nota ${esc(fmtQty(line.qty))}</div></div>
      <span>${esc(fmtMoney(line.amount))}</span>
    </div>
    <div class="tally-check-row">
      <input type="checkbox" id="tl-${line.id}" checked data-include>
      <label for="tl-${line.id}">Hitung baris ini</label>
    </div>
    <div class="tally-fields">
      <div class="field"><label class="field-label">Kategori</label><div class="select-wrap"><select class="input" data-kind-select><option value="FRESH">FRESH — harga nota</option><option value="AFKIR">AFKIR — harga 0</option></select>${icon("chevronDown", 14, "select-chevron")}</div></div>
      <div class="field"><label class="field-label">Qty</label><input class="input" type="number" data-qty min="0.0001" max="${esc(line.qty)}" step="any" value="${esc(line.qty)}"></div>
      <div class="field"><label class="field-label">Catatan</label><input class="input" type="text" data-line-note maxlength="300" placeholder="Opsional"></div>
    </div>
  </div>`).join("");
  const modal = openModal({
    title: "Tally & afkir",
    eyebrow: "Pemeriksaan mutu",
    subtitle: `${detail.note_display} · ${detail.rit?.seller_name || ""}`,
    size: "lg",
    body: `<div class="inline-meta" style="margin-bottom:8px"><span>${icon("tally", 13)} ${eligible.length} baris siap ditally</span><span>${icon("info", 13)} Satu baris nota hanya dapat memiliki satu tally aktif.</span></div>
      <div id="tally-lines">${rows}</div>
      <div class="tally-total-card"><div><span>Total tally terpilih</span><div style="font-size:10px;color:var(--muted);margin-top:1px" id="tally-meta">0 baris</div></div><strong id="tally-total">Rp 0</strong></div>
      <div class="signature-box"><div class="field"><label class="field-label" for="tally-signature">Nama pemeriksa / tanda tangan <span class="req">*</span></label><input class="input" id="tally-signature" data-signature type="text" minlength="3" maxlength="100" required placeholder="cth. Pak Slamet"></div><button class="btn btn-primary" type="button" data-save-tally>${icon("save", 16)} Simpan tally</button></div>`,
    footer: `<button class="btn btn-ghost" type="button" data-layer-close>Batal</button><button class="btn btn-secondary" type="button" data-fill-all>${icon("checkCircle", 15)} Semua FRESH</button>`,
  });
  const body = modal.bodyEl;
  const signature = body.querySelector("[data-signature]");
  const saveButton = body.querySelector("[data-save-tally]");
  const numbers = body.querySelectorAll("[data-qty]");
  const recalc = () => {
    let amount = 0;
    let qtyTotal = 0;
    let count = 0;
    body.querySelectorAll(".tally-line").forEach((node) => {
      const include = node.querySelector("[data-include]").checked;
      const qtyInput = node.querySelector("[data-qty]");
      const qty = include ? Number(qtyInput.value || 0) : 0;
      qtyInput.disabled = !include;
      node.querySelector("[data-kind-select]").disabled = !include;
      node.querySelector("[data-line-note]").disabled = !include;
      if (!include || !(qty > 0)) return;
      const kind = node.querySelector("[data-kind-select]").value;
      const price = Number(node.dataset.price || 0);
      const volume = (Number(node.dataset.l) * Number(node.dataset.t) * Number(node.dataset.p) * qty) / 10000000;
      amount += kind === "FRESH" ? volume * price : 0;
      qtyTotal += qty;
      count += 1;
    });
    body.querySelector("#tally-total").textContent = fmtMoney(amount);
    body.querySelector("#tally-meta").textContent = `${fmtQty(qtyTotal)} batang · ${count} baris terpilih`;
  };
  body.querySelectorAll("[data-include]").forEach((input) => input.addEventListener("change", recalc));
  numbers.forEach((input) => input.addEventListener("input", recalc));
  body.querySelectorAll("[data-kind-select]").forEach((input) => input.addEventListener("change", recalc));
  modal.footerEl.querySelector("[data-fill-all]")?.addEventListener("click", () => {
    body.querySelectorAll("[data-include]").forEach((input) => { input.checked = true; });
    body.querySelectorAll("[data-kind-select]").forEach((input) => { input.value = "FRESH"; });
    body.querySelectorAll("[data-qty]").forEach((input) => {
      const line = input.closest(".tally-line");
      const source = (detail.lines || []).find((row) => Number(row.id) === Number(line.dataset.line));
      if (source) input.value = source.qty;
    });
    recalc();
  });
  recalc();
  saveButton.addEventListener("click", async () => {
    if (String(signature.value || "").trim().length < 3) {
      signature.focus();
      toast.warn("Nama pemeriksa minimal 3 karakter.");
      return;
    }
    const items = [];
    const nodes = [...body.querySelectorAll(".tally-line")];
    for (const node of nodes) {
      if (!node.querySelector("[data-include]").checked) continue;
      const qty = Number(node.querySelector("[data-qty]").value || 0);
      if (!(qty > 0)) {
        toast.warn("Qty tally harus lebih dari 0.");
        node.querySelector("[data-qty]").focus();
        return;
      }
      items.push({
        trx_id: Number(node.dataset.line),
        qty,
        kind: node.querySelector("[data-kind-select]").value,
        note: node.querySelector("[data-line-note]").value.trim(),
      });
    }
    if (!items.length) {
      toast.warn("Pilih minimal satu baris untuk ditally.");
      return;
    }
    setBusy(saveButton, true, "Menyimpan…");
    try {
      const result = await api.post(`/api/rits/${state.ritId}/notes/${encodeURIComponent(detail.note)}/tally`, {
        items,
        signature: signature.value.trim(),
      });
      toast.success(`Tally ${result.tally_number} tersimpan.`);
      modal.close();
      onDone?.();
      await Promise.all([loadNotes(), reloadRitsQuiet()]);
      refreshAllMeta().catch(() => {});
      window.setTimeout(() => openNoteDetail(detail.note), 250);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(saveButton, false);
    }
  });
}

/* ------------------------------------------------------------------ boot */

export async function render(root, { query }) {
  root.innerHTML = layout();
  document.getElementById("recv-month").addEventListener("change", async (event) => {
    state.month = event.target.value || "";
    await loadRits();
  });
  document.getElementById("seller-search").addEventListener("input", (event) => {
    state.sellerQuery = event.target.value;
    renderSellers();
  });
  document.getElementById("rit-search").addEventListener("input", (event) => {
    const term = event.target.value.trim().toLowerCase();
    document.querySelectorAll("[data-rit]").forEach((node) => {
      const row = state.rits.find((item) => Number(item.id) === Number(node.dataset.rit));
      const text = row ? `${row.rit_number} ${row.delivery_number}`.toLowerCase() : "";
      node.style.display = text.includes(term) ? "" : "none";
    });
  });
  root.addEventListener("click", async (event) => {
    const seller = event.target.closest("[data-seller]");
    if (seller) {
      await selectSeller(seller.dataset.seller);
      return;
    }
    const rit = event.target.closest("[data-rit]");
    if (rit) {
      await selectRit(rit.dataset.rit);
      return;
    }
    const note = event.target.closest("[data-note]");
    if (note) {
      event.preventDefault();
      await openNoteDetail(note.dataset.note);
      return;
    }
    if (event.target.closest("[data-new-rit]")) {
      openRitForm();
      return;
    }
    if (event.target.closest("[data-add-note]")) {
      openAddNote();
      return;
    }
    if (event.target.closest("[data-edit-rit]")) {
      const current = currentRit();
      if (current) openRitForm({ rit: current });
      return;
    }
    if (event.target.closest("[data-delete-rit]")) {
      await deleteRit();
      return;
    }
    const tallyButton = event.target.closest("[data-tally]");
    if (tallyButton) {
      try {
        const detail = await api.get(`/api/rits/${state.ritId}/notes/${encodeURIComponent(tallyButton.dataset.tally)}`);
        await openTallyModal(detail);
      } catch (error) {
        toast.error(error.message);
      }
      return;
    }
    const recapButton = event.target.closest("[data-recap]");
    if (recapButton) {
      await createRecap(recapButton.dataset.recap);
      return;
    }
    if (event.target.closest("[data-refresh]")) {
      await bootData();
    }
  });
  async function bootData() {
    try {
      await loadSellers();
      await loadRits();
    } catch (error) {
      toast.error(error.message || "Penerimaan belum dapat dimuat.");
    }
  }
  await bootData();
  if (query?.get("seller")) {
    const target = Number(query.get("seller"));
    if (state.sellers.some((row) => Number(row.id) === target)) {
      await selectSeller(target);
    }
  }
}
