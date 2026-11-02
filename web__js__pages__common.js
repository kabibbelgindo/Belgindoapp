import { icon } from "../icons.js";
import { state, refreshMeta, setMeta } from "../state.js";
import {
  badge, emptyState, errorState, esc, fmtDate, fmtMoney, fmtM3, fmtQty, fmtSize,
  infoBanner, openForm, openModal, toast, todayISO,
} from "../ui.js";
import { api } from "../api.js";

export function meta() {
  return state.meta || {};
}

export function masters() {
  return meta().masters || {};
}

export function products({ includeImport = true, placeholder = "Pilih barang" } = {}) {
  return (masters().products || [])
    .filter((row) => includeImport || !String(row.code || "").toUpperCase().startsWith("IMP/"))
    .map((row) => ({
      value: row.id,
      label: `${row.code} · ${row.name}${row.spec_t ? ` (${fmtSizeSize(row)})` : ""}`,
      row,
    }));
}

function fmtSizeSize(row) {
  const values = [row.spec_l, row.spec_t, row.spec_p];
  if (values.some((value) => value === null || value === undefined || value === "")) return "";
  return `${Number(row.spec_t)}×${Number(row.spec_l)}×${Number(row.spec_p)}`;
}

export function productLabel(productId) {
  const row = (masters().products || []).find((item) => Number(item.id) === Number(productId));
  return row ? `${row.code} · ${row.name}` : "-";
}

export function locations({ includeEmpty = false, placeholder = "Pilih lokasi" } = {}) {
  const rows = (masters().locations || []).map((row) => ({
    value: row.code,
    label: row.name && row.name !== row.code ? `${row.code} — ${row.name}` : row.code,
  }));
  if (includeEmpty) rows.unshift({ value: "", label: "Tanpa lokasi" });
  return rows;
}

export function sellers() {
  return (masters().sellers || []).map((row) => ({
    value: row.id,
    label: row.city ? `${row.name} — ${row.city}` : row.name,
  }));
}

export function specsFor(dimension) {
  return (masters().specs?.[dimension] || []).map((row) => row.value);
}

export function priceOptions() {
  return (masters().prices || []).map((value) => ({ value, label: fmtMoney(value) }));
}

export function reasonOptions(extra = []) {
  const reasons = meta().constants?.opname_reasons || [];
  return [...extra, ...reasons].map((value) => ({ value, label: value }));
}

export function pageHead({ eyebrow = "", title = "", subtitle = "", actions = "" }) {
  return `<div class="page-head">
    <div>
      ${eyebrow ? `<span class="eyebrow">${icon("sparkles", 13)} ${esc(eyebrow)}</span>` : ""}
      <h1>${esc(title)}</h1>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ""}
  </div>`;
}

export function sectionHead(title, subtitle = "", actions = "") {
  return `<div class="section-head">
    <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div>
    ${actions || ""}
  </div>`;
}

export function blankCard(content, { className = "", flush = false } = {}) {
  return `<div class="card ${flush ? "card-flush" : ""} ${className}">${content}</div>`;
}

export function loadingCard(label = "Memuat data…") {
  return `<div class="card"><div class="loading-block"><span class="spinner"></span><span>${esc(label)}</span></div></div>`;
}

export function emptyCard(options) {
  return `<div class="card">${emptyState(options)}</div>`;
}

export function errorCard(error, retry) {
  return `<div class="card card-pad">${errorState(error?.message || String(error || "Terjadi kesalahan."))}</div>${retry ? "" : ""}`;
}

export function bindRetry(root, callback) {
  root.querySelectorAll("[data-retry]").forEach((button) => {
    button.addEventListener("click", () => callback());
  });
}

export function showError(root, error, callback) {
  root.innerHTML = `<div class="card card-pad">${errorState(error?.message || "Permintaan gagal diproses.")}</div>`;
  bindRetry(root, callback);
}

export function setPageChrome({ title, subtitle, eyebrow }) {
  document.title = `${title || "PT. Belgindo Raya Inventory"} · PT. Belgindo Raya Inventory`;
  const titleEl = document.getElementById("topbar-title");
  const subEl = document.getElementById("topbar-subtitle");
  const eyebrowEl = document.getElementById("topbar-eyebrow");
  if (titleEl) titleEl.textContent = title || "PT. BELGINDO RAYA INVENTORY";
  if (subEl) subEl.textContent = subtitle || "";
  if (eyebrowEl) eyebrowEl.textContent = eyebrow || "PT. BELGINDO RAYA INVENTORY";
}

export async function downloadExport(name, params, fallbackName, button) {
  const previous = button ? button.innerHTML : "";
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner-xs"></span><span>Menyiapkan…</span>`;
  }
  try {
    const filename = await api.download(`/api/exports/${name}`, params, fallbackName || `ekspor-${name}.xlsx`);
    toast.success(`Berkas ${filename} berhasil diunduh.`);
    return filename;
  } catch (error) {
    toast.error(error.message || "Ekspor gagal.");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = previous;
    }
  }
}

export function exportButton(label = "Ekspor Excel", { name = "transactions", params = {}, fallback = "" } = {}) {
  return `<button class="btn btn-secondary" type="button" data-export="${esc(name)}" data-params='${esc(JSON.stringify(params))}' data-fallback="${esc(fallback)}">${icon("download", 16)} ${esc(label)}</button>`;
}

export function bindExports(root) {
  root.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => {
      let params = {};
      try {
        params = JSON.parse(button.dataset.params || "{}");
      } catch {
        params = {};
      }
      downloadExport(button.dataset.export, params, button.dataset.fallback, button).catch(() => {});
    });
  });
}

export function cancelReasonDialog({ title, message, confirmLabel = "Batalkan", details = "", requireText = "" }) {
  return openForm({
    title,
    eyebrow: "Pembatalan",
    subtitle: "Tindakan ini tercatat pada log aktivitas.",
    fields: [
      ...(requireText ? [{ name: "confirmation", label: `Ketik ${requireText}`, type: "text", required: true, placeholder: requireText, autofocus: true }] : []),
      { name: "reason", label: "Alasan pembatalan", type: "textarea", rows: 3, full: true, placeholder: "Jelaskan alasan pembatalan (opsional)", maxlength: 300 },
    ],
    values: {},
    submitLabel: confirmLabel,
    submitIcon: "alert",
    danger: true,
    intro: infoBanner(message || "Data akan dibatalkan dan tidak dihitung lagi.", { tone: "warn", iconName: "alert" }) + (details ? `<div class="mt-12">${details}</div>` : ""),
    onSubmit: async (values, { close }) => {
      close();
      return values;
    },
  });
}

export async function askText({ title, message, label, placeholder = "", confirmLabel = "Lanjutkan", danger = false, required = true }) {
  let captured = null;
  const modal = openForm({
    title,
    eyebrow: "Konfirmasi",
    subtitle: message || "",
    fields: [{ name: "text", label, type: "textarea", rows: 3, full: true, required, placeholder, autofocus: true, maxlength: 300 }],
    submitLabel: confirmLabel,
    danger,
    onSubmit: async (values, { close }) => {
      captured = String(values.text || "").trim();
      close();
    },
  });
  await new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (!document.body.contains(modal.overlay)) {
        window.clearInterval(timer);
        resolve();
      }
    }, 100);
  });
  return captured;
}

export function statusTone(label) {
  const key = String(label || "").toUpperCase();
  if (key === "DITUTUP") return "neutral";
  if (key === "DISAHKAN") return "blue";
  if (key === "PENGHITUNGAN") return "amber";
  return "neutral";
}

export function toolbarField(label, inner, { className = "" } = {}) {
  return `<div class="field ${className}"><label class="field-label">${esc(label)}</label>${inner}</div>`;
}

export function dateInput(name, value, { label = "Tanggal", max = "", className = "" } = {}) {
  return `<div class="field ${className}"><label class="field-label" for="filter-${esc(name)}">${esc(label)}</label>
    <input class="input" id="filter-${esc(name)}" name="${esc(name)}" type="date" value="${esc(value || "")}" ${max ? `max="${esc(max)}"` : ""}>
  </div>`;
}

export function monthInput(name, value, { label = "Bulan", className = "" } = {}) {
  return `<div class="field ${className}"><label class="field-label" for="filter-${esc(name)}">${esc(label)}</label>
    <input class="input" id="filter-${esc(name)}" name="${esc(name)}" type="month" value="${esc(value || "")}">
  </div>`;
}

export function searchInput(name, value, { label = "Cari", placeholder = "Cari…", className = "grow-field" } = {}) {
  return `<div class="field ${className}"><label class="field-label" for="filter-${esc(name)}">${esc(label)}</label>
    <input class="input" id="filter-${esc(name)}" name="${esc(name)}" type="search" value="${esc(value || "")}" placeholder="${esc(placeholder)}">
  </div>`;
}

export function selectField(name, label, options, selected, { className = "", placeholder = "" } = {}) {
  return `<div class="field ${className}"><label class="field-label" for="filter-${esc(name)}">${esc(label)}</label>
    <div class="select-wrap"><select class="input" id="filter-${esc(name)}" name="${esc(name)}">
      ${placeholder ? `<option value="">${esc(placeholder)}</option>` : ""}
      ${options.map((option) => {
        const value = option.value ?? option;
        const text = option.label ?? option;
        return `<option value="${esc(value)}" ${String(selected) === String(value) ? "selected" : ""}>${esc(text)}</option>`;
      }).join("")}
    </select>${icon("chevronDown", 15, "select-chevron")}</div>
  </div>`;
}

export function readForm(root) {
  const data = {};
  root.querySelectorAll("[name]").forEach((field) => {
    if (field.type === "checkbox") data[field.name] = field.checked;
    else data[field.name] = typeof field.value === "string" ? field.value.trim() : field.value;
  });
  return data;
}

export function refreshAllMeta() {
  return refreshMeta().catch(() => {});
}

export function applyMeta(meta) {
  setMeta(meta);
}

export function moneyCell(value, { strong = false } = {}) {
  return `<span class="${strong ? "strong num" : "num"}">${esc(fmtMoney(value))}</span>`;
}

export function qtyCell(value) {
  return `<span class="num">${esc(fmtQty(value))}</span>`;
}

export function m3Cell(value) {
  return `<span class="num">${esc(fmtM3(value))}</span>`;
}

export function sizeChip(size) {
  return `<span class="size">${esc(size || "-")}</span>`;
}

export function statusBadgeCustom(label) {
  return badge(label, statusTone(label));
}

export function printHead(title, period = "") {
  const app = meta().app || {};
  return `<div class="report-print-head">
    <div class="print-company">${esc(app.name || "PT. BELGINDO RAYA INVENTORY")}<small>Inventori Kayu</small></div>
    <div class="print-title"><h2>${esc(title)}</h2><p>${esc(period || fmtDate(new Date()))}</p></div>
  </div>`;
}

export function pct(part, total) {
  if (!Number(total)) return "0%";
  return `${Math.round((Number(part) / Number(total)) * 100)}%`;
}

export function todayInput() {
  return todayISO();
}

export function promptReason({
  title,
  message = "Tindakan ini tercatat pada log aktivitas.",
  eyebrow = "Pembatalan",
  confirmLabel = "Batalkan",
  label = "Alasan (opsional)",
  placeholder = "Jelaskan alasan pembatalan",
  iconName = "alert",
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      eyebrow,
      size: "sm",
      iconName,
      body: `<p class="confirm-message">${esc(message)}</p>
        <form class="form-grid" id="reason-form">
          <div class="field field-full"><label class="field-label" for="cancel-reason">${esc(label)}</label>
            <textarea class="input textarea" id="cancel-reason" name="reason" rows="3" maxlength="300" placeholder="${esc(placeholder)}" autofocus></textarea>
          </div>
        </form>`,
      footer: `<button class="btn btn-ghost" type="button" data-layer-close>Batal</button>
        <button class="btn btn-danger" type="button" data-confirm-reason">${icon(iconName, 16)} ${esc(confirmLabel)}</button>`,
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

export function dateRange(days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end) };
}

export function friendlyError(error) {
  const text = error?.message || "Terjadi kesalahan.";
  return text;
}

export function iconText(name, text) {
  return `${icon(name, 14)} ${esc(text)}`;
}

export function statusLine(label, value, tone = "") {
  return `<div class="status-line"><span>${esc(label)}</span><strong class="${tone}">${esc(value)}</strong></div>`;
}

export function noteBadge(label, tone = "neutral") {
  return badge(label, tone);
}
