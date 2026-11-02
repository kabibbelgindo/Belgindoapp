import { icon } from "./icons.js";

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function esc(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (char) => ESCAPES[char]);
}

/* Interaksi desktop: elemen baris yang memiliki data-context-edit atau
   data-context-delete otomatis mendapat menu klik kanan dan dobel klik untuk
   membuka aksi ubah. Nilainya adalah selector relatif/global ke tombol aksi
   yang sudah dipakai halaman, sehingga aturan bisnis dan dialog konfirmasi
   tetap terpusat pada handler lama. */
let contextMenuEl = null;
function closeContextMenu() {
  contextMenuEl?.remove();
  contextMenuEl = null;
}
function dispatchAction(selector) {
  if (!selector) return;
  let action = null;
  try { action = document.querySelector(selector); } catch { action = null; }
  if (action && !action.disabled) action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
function openContextMenu(event, target) {
  if (target.matches?.("[data-rit]")) target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  closeContextMenu();
  const editSelector = target.dataset.contextEdit;
  const deleteSelector = target.dataset.contextDelete;
  const openSelector = target.dataset.contextOpen;
  const items = [
    editSelector ? { label: "Ubah", icon: "edit", selector: editSelector } : null,
    openSelector ? { label: "Buka detail", icon: "eye", selector: openSelector } : null,
    deleteSelector ? { label: "Hapus", icon: "trash", selector: deleteSelector, danger: true } : null,
  ].filter(Boolean);
  if (!items.length) return;
  event.preventDefault();
  const menu = document.createElement("div");
  menu.className = "context-menu-float";
  menu.setAttribute("role", "menu");
  menu.innerHTML = items.map((item) => `<button type="button" role="menuitem" class="context-menu-item${item.danger ? " is-danger" : ""}">${icon(item.icon, 15)}<span>${item.label}</span></button>`).join("");
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - items.length * 42 - 12)}px`;
  menu.addEventListener("click", (clickEvent) => {
    const index = [...menu.querySelectorAll("button")].indexOf(clickEvent.target.closest("button"));
    const item = items[index];
    closeContextMenu();
    if (item) dispatchAction(item.selector);
  });
  document.body.appendChild(menu);
  contextMenuEl = menu;
}
document.addEventListener("contextmenu", (event) => {
  const target = event.target.closest?.("[data-context-edit], [data-context-delete], [data-context-open]");
  if (target) openContextMenu(event, target);
}, true);
document.addEventListener("dblclick", (event) => {
  const target = event.target.closest?.("[data-context-edit]");
  const interactive = event.target.closest?.("button, a, input, textarea, select");
  if (interactive && interactive !== target) return;
  if (target) {
    event.preventDefault();
    if (target.matches?.("[data-rit]")) target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    dispatchAction(target.dataset.contextEdit);
  }
}, true);
document.addEventListener("click", (event) => {
  if (contextMenuEl && !event.target.closest(".context-menu-float")) closeContextMenu();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeContextMenu();
});

/* Long-press (mobile) sebagai pengganti klik kanan / double-click */
let longPressTimer = null;
let longPressTarget = null;
document.addEventListener("touchstart", (event) => {
  const target = event.target.closest?.("[data-context-edit], [data-context-delete], [data-context-open]");
  if (!target) return;
  longPressTarget = target;
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    const touch = event.touches[0] || event.changedTouches[0];
    const fakeEvent = {
      clientX: touch.clientX,
      clientY: touch.clientY,
      preventDefault() {},
      stopPropagation() {},
    };
    openContextMenu(fakeEvent, target);
  }, 550);
}, { passive: true });
document.addEventListener("touchend", () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  longPressTarget = null;
}, { passive: true });
document.addEventListener("touchmove", () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}, { passive: true });

const contextMenuStyle = document.createElement("style");
contextMenuStyle.textContent = `.context-menu-float{position:fixed;z-index:10000;min-width:178px;padding:5px;background:var(--surface,#fff);border:1px solid var(--line,#d8dde5);border-radius:10px;box-shadow:0 12px 30px rgba(15,23,42,.2)}.context-menu-item{display:flex;align-items:center;gap:9px;width:100%;padding:10px 12px;border:0;border-radius:7px;background:transparent;color:var(--ink,#172033);font:inherit;text-align:left;cursor:pointer}.context-menu-item:hover{background:var(--surface-2,#eef2f7)}.context-menu-item.is-danger{color:var(--danger,#b42318)}`;
document.head.appendChild(contextMenuStyle);

const MONTHS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

const nfQty = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });
const nfM3 = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 6 });
const nfInt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).slice(0, 10);
  const parts = text.split("-");
  if (parts.length === 3) {
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function localISO(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayISO() {
  return localISO();
}

export function monthISO(date = new Date()) {
  return localISO(date).slice(0, 7);
}

export function firstOfMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export function fmtQty(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return nfQty.format(number);
}

export function fmtM3(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return nfM3.format(number);
}

export function fmtInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? nfInt.format(number) : "0";
}

export function fmtMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Rp 0";
  const sign = number < 0 ? "-" : "";
  return `${sign}Rp ${nfInt.format(Math.abs(number))}`;
}

export function fmtMoneyShort(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Rp 0";
  const abs = Math.abs(number);
  const sign = number < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}Rp ${nfQty.format(abs / 1e12)} T`;
  if (abs >= 1e9) return `${sign}Rp ${nfQty.format(abs / 1e9)} M`;
  if (abs >= 1e6) return `${sign}Rp ${nfQty.format(abs / 1e6)} jt`;
  if (abs >= 1e3) return `${sign}Rp ${nfQty.format(abs / 1e3)} rb`;
  return `${sign}Rp ${nfInt.format(abs)}`;
}

export function fmtDate(value, short = false) {
  const date = asDate(value);
  if (!date) return "-";
  const day = String(date.getDate()).padStart(2, "0");
  return `${day} ${(short ? MONTHS_SHORT : MONTHS)[date.getMonth()]} ${date.getFullYear()}`;
}

export function fmtDateShort(value) {
  const date = asDate(value);
  if (!date) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

export function fmtDateFull(value) {
  const date = asDate(value);
  if (!date) return "-";
  return `${DAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function fmtDateTime(value) {
  if (!value) return "-";
  const text = String(value);
  const datePart = fmtDate(text);
  const timePart = text.slice(11, 16);
  return timePart ? `${datePart} · ${timePart}` : datePart;
}

export function fmtMonth(value) {
  const text = String(value || "");
  const parts = text.split("-");
  if (parts.length < 2) return text || "-";
  const month = Number(parts[1]) - 1;
  return `${MONTHS[month] || parts[1]} ${parts[0]}`;
}

export function fmtSize(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const parts = text.split("x");
  if (parts.length !== 3) return text;
  return `${parts[1]} × ${parts[0]} × ${parts[2]}`;
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "Selamat pagi";
  if (hour < 15) return "Selamat siang";
  if (hour < 19) return "Selamat sore";
  return "Selamat malam";
}

export function initials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

export function toNumber(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const cleaned = String(value).replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function debounce(fn, delay = 300) {
  let timer = null;
  const wrapped = (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => window.clearTimeout(timer);
  wrapped.flush = (...args) => {
    window.clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function bind(root, selector, type, handler, options) {
  root.addEventListener(type, (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  }, options);
}

export function optionsHTML(items, selected, { placeholder = "", disabledPlaceholder = false } = {}) {
  const chunks = [];
  if (placeholder) {
    chunks.push(`<option value="" ${selected === "" || selected === null || selected === undefined ? "selected" : ""} ${disabledPlaceholder ? "disabled" : ""}>${esc(placeholder)}</option>`);
  }
  for (const item of items || []) {
    let value;
    let label;
    let disabled = false;
    if (item !== null && typeof item === "object") {
      value = item.value;
      label = item.label ?? item.value;
      disabled = Boolean(item.disabled);
    } else {
      value = item;
      label = item;
    }
    const isSelected = selected !== undefined && selected !== null && String(selected) === String(value);
    chunks.push(`<option value="${esc(value)}" ${isSelected ? "selected" : ""} ${disabled ? "disabled" : ""}>${esc(label)}</option>`);
  }
  return chunks.join("");
}

export function badge(label, tone = "neutral", dot = false) {
  return `<span class="badge badge-${esc(tone)}">${dot ? '<span class="badge-dot"></span>' : ""}${esc(label)}</span>`;
}

export function statusBadge(status) {
  const key = String(status || "").toUpperCase();
  const map = {
    POSTED: ["Aktif", "green"],
    AKTIF: ["Aktif", "green"],
    BATAL: ["Dibatalkan", "red"],
    DRAFT: ["Penghitungan", "amber"],
    DONE: ["Disahkan", "blue"],
    DITUTUP: ["Ditutup", "neutral"],
    PENGHITUNGAN: ["Penghitungan", "amber"],
    DISAHKAN: ["Disahkan", "blue"],
    PENDING: ["Menunggu", "amber"],
    FAILED: ["Gagal", "red"],
    SYNCED: ["Tersinkron", "green"],
    FRESH: ["Fresh", "green"],
    AFKIR: ["Afkir", "amber"],
  };
  const entry = map[key] || [status || "—", "neutral"];
  return badge(entry[0], entry[1], key === "POSTED" || key === "AKTIF");
}

export function emptyState({ iconName = "inbox", title = "Belum ada data", text = "", action = "", compact = false }) {
  return `<div class="empty-state ${compact ? "empty-compact" : ""}">
    <span class="empty-icon">${icon(iconName, 26)}</span>
    <strong>${esc(title)}</strong>
    ${text ? `<p>${esc(text)}</p>` : ""}
    ${action ? `<div class="empty-action">${action}</div>` : ""}
  </div>`;
}

export function errorState(message, { retry = true } = {}) {
  return `<div class="error-state" role="alert">
    <span class="error-icon">${icon("alert", 24)}</span>
    <div><strong>Ada yang tidak berjalan</strong><p>${esc(message || "Permintaan gagal diproses.")}</p></div>
    ${retry ? `<button class="btn btn-secondary btn-sm" type="button" data-retry>${icon("refresh", 16)} Coba lagi</button>` : ""}
  </div>`;
}

export function skeleton(rows = 4, { cards = 0 } = {}) {
  const cardHTML = cards
    ? `<div class="skeleton-cards">${Array.from({ length: cards }, () => '<div class="skeleton skeleton-card"></div>').join("")}</div>`
    : "";
  return `${cardHTML}<div class="skeleton-table">${Array.from({ length: rows }, (_, index) => `<div class="skeleton skeleton-row" style="--w:${62 + ((index * 13) % 30)}%"></div>`).join("")}</div>`;
}

export function lockBanner(meta, customText = "") {
  const locked = meta?.lock?.locked_through;
  if (!locked) return "";
  const label = meta?.lock?.locked_through_display || fmtDate(locked);
  return `<div class="banner banner-lock">
    <span class="banner-icon">${icon("lock", 18)}</span>
    <div><strong>Periode terkunci sampai ${esc(label)}</strong>
    <p>${esc(customText || "Transaksi bertanggal pada periode yang sudah ditutup tidak dapat ditambah, diubah, atau dibatalkan.")}</p></div>
  </div>`;
}

export function infoBanner(text, { tone = "info", iconName = "info", title = "" } = {}) {
  return `<div class="banner banner-${esc(tone)}">
    <span class="banner-icon">${icon(iconName, 18)}</span>
    <div>${title ? `<strong>${esc(title)}</strong>` : ""}<p>${esc(text)}</p></div>
  </div>`;
}

/* ------------------------------------------------------------------ toast */

const toastRoot = () => document.getElementById("toast-root");

function showToast(message, tone = "success", title = "") {
  const root = toastRoot();
  if (!root) return;
  while (root.children.length >= 4) root.firstElementChild?.remove();
  const iconName = tone === "error" ? "alert" : tone === "warn" ? "alert" : tone === "info" ? "info" : "checkCircle";
  const node = document.createElement("div");
  node.className = `toast toast-${tone}`;
  node.setAttribute("role", tone === "error" ? "alert" : "status");
  node.innerHTML = `<span class="toast-icon">${icon(iconName, 19)}</span>
    <div class="toast-copy">${title ? `<strong>${esc(title)}</strong>` : ""}<span>${esc(message)}</span></div>
    <button class="toast-close" type="button" aria-label="Tutup notifikasi">${icon("x", 15)}</button>`;
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add("is-visible"));
  const close = () => {
    node.classList.remove("is-visible");
    window.setTimeout(() => node.remove(), 220);
  };
  node.querySelector(".toast-close").addEventListener("click", close);
  window.setTimeout(close, tone === "error" ? 6500 : 4200);
}

export const toast = {
  success: (message, title = "") => showToast(message, "success", title),
  error: (message, title = "") => showToast(message, "error", title),
  info: (message, title = "") => showToast(message, "info", title),
  warn: (message, title = "") => showToast(message, "warn", title),
};

/* ------------------------------------------------------------------ overlays */

const layers = [];
let layerListenerBound = false;

function syncBodyLock() {
  document.body.classList.toggle("has-overlay", layers.length > 0);
}

function closeTopLayer() {
  const layer = layers[layers.length - 1];
  if (layer && layer.dismissible) layer.close();
}

function bindLayerKeys() {
  if (layerListenerBound) return;
  layerListenerBound = true;
  document.addEventListener("keydown", (event) => {
    if (!layers.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeTopLayer();
      return;
    }
    if (event.key !== "Tab") return;
    const layer = layers[layers.length - 1];
    const focusables = [...layer.rootEl.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function buildLayer({ kind, title, subtitle, eyebrow, body, footer, size = "md", dismissible = true, iconName = "", onMount, onClose, className = "" }) {
  bindLayerKeys();
  const root = document.getElementById("overlay-root") || document.body;
  const overlay = document.createElement("div");
  overlay.className = `overlay overlay-${kind}`;
  const panelClass = kind === "drawer" ? `drawer drawer-${size}` : `modal modal-${size}`;
  overlay.innerHTML = `<div class="overlay-scrim" data-scrim></div>
    <section class="${panelClass} ${className}" role="dialog" aria-modal="true" aria-labelledby="layer-title">
      <header class="layer-head">
        <div class="layer-heading">
          ${iconName ? `<span class="layer-icon">${icon(iconName, 20)}</span>` : ""}
          <div>
            ${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ""}
            <h2 id="layer-title">${esc(title || "")}</h2>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
          </div>
        </div>
        <button class="icon-btn layer-close" type="button" data-close aria-label="Tutup">${icon("x", 19)}</button>
      </header>
      <div class="layer-body">${body || ""}</div>
      ${footer ? `<footer class="layer-foot">${footer}</footer>` : ""}
    </section>`;
  root.appendChild(overlay);
  const panel = overlay.querySelector(`.${kind === "drawer" ? "drawer" : "modal"}`);
  let closed = false;
  const layer = {
    overlay,
    rootEl: panel,
    bodyEl: overlay.querySelector(".layer-body"),
    footerEl: overlay.querySelector(".layer-foot"),
    dismissible,
    close(result) {
      if (closed) return;
      closed = true;
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      overlay.classList.add("is-closing");
      overlay.classList.remove("is-open");
      window.setTimeout(() => {
        overlay.remove();
        syncBodyLock();
        onClose?.(result);
      }, 180);
    },
  };
  layers.push(layer);
  syncBodyLock();
  overlay.querySelector(".overlay-scrim")?.addEventListener("click", () => {
    if (dismissible) layer.close();
  });
  overlay.querySelector("[data-close]")?.addEventListener("click", () => layer.close());
  overlay.addEventListener("click", (event) => {
    const closer = event.target.closest("[data-layer-close]");
    if (closer) layer.close();
  });
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  onMount?.(layer);
  window.setTimeout(() => {
    const auto = panel.querySelector("[autofocus]");
    const first = panel.querySelector('input:not([type="hidden"]), select, textarea, button:not([data-close])');
    (auto || first || panel.querySelector("[data-close]"))?.focus({ preventScroll: true });
  }, 80);
  return layer;
}

export function openModal(options) {
  return buildLayer({ ...options, kind: "modal" });
}

export function openDrawer(options) {
  return buildLayer({ ...options, kind: "drawer" });
}

export function plainOverlayOpen() {
  return layers.length > 0;
}

export function closeAllLayers() {
  for (const layer of [...layers].reverse()) layer.close();
}

/* ------------------------------------------------------------------ forms */

function fieldHTML(field, values) {
  if (field.type === "hidden") {
    return `<input type="hidden" name="${esc(field.name)}" value="${esc(values[field.name] ?? field.value ?? "")}">`;
  }
  if (field.type === "static") {
    return `<div class="field field-full"><span class="field-label">${esc(field.label || "")}</span><div class="field-static">${field.html || esc(field.value ?? "—")}</div>${field.help ? `<span class="field-help">${esc(field.help)}</span>` : ""}</div>`;
  }
  if (field.type === "custom") {
    return `<div class="field ${field.full ? "field-full" : ""}">${field.label ? `<label class="field-label">${esc(field.label)}</label>` : ""}${field.html || ""}</div>`;
  }
  const raw = values[field.name];
  const value = raw === undefined || raw === null ? (field.value ?? "") : raw;
  const name = esc(field.name);
  const id = `f-${field.name}`;
  const required = field.required ? "required" : "";
  const readonly = field.readonly ? "readonly" : "";
  const disabled = field.disabled ? "disabled" : "";
  const autofocus = field.autofocus ? "autofocus" : "";
  const help = field.help ? `<span class="field-help">${esc(field.help)}</span>` : "";
  const label = field.label
    ? `<label class="field-label" for="${id}">${esc(field.label)}${field.required ? ' <span class="req" aria-hidden="true">*</span>' : ""}</label>`
    : "";
  const common = `id="${id}" name="${name}" ${required} ${readonly} ${disabled} ${autofocus}`;
  let control = "";
  if (field.type === "select") {
    control = `<div class="select-wrap"><select class="input" ${common}>${optionsHTML(field.options, value, {
      placeholder: field.placeholder || "",
    })}</select>${icon("chevronDown", 15, "select-chevron")}</div>`;
  } else if (field.type === "textarea") {
    control = `<textarea class="input textarea" ${common} rows="${esc(field.rows || 3)}" placeholder="${esc(field.placeholder || "")}" ${field.maxlength ? `maxlength="${esc(field.maxlength)}"` : ""}>${esc(value)}</textarea>`;
  } else if (field.type === "checkbox") {
    return `<label class="field field-check ${field.full ? "field-full" : ""}">
      <input type="checkbox" name="${name}" id="${id}" ${value ? "checked" : ""} ${disabled}>
      <span><strong>${esc(field.label || "")}</strong>${field.help ? `<small>${esc(field.help)}</small>` : ""}</span>
    </label>`;
  } else {
    const attrs = [
      field.min !== undefined ? `min="${esc(field.min)}"` : "",
      field.max !== undefined ? `max="${esc(field.max)}"` : "",
      field.step !== undefined ? `step="${esc(field.step)}"` : "",
      field.pattern ? `pattern="${esc(field.pattern)}"` : "",
      field.inputmode ? `inputmode="${esc(field.inputmode)}"` : "",
      field.maxlength ? `maxlength="${esc(field.maxlength)}"` : "",
      field.minlength ? `minlength="${esc(field.minlength)}"` : "",
    ].filter(Boolean).join(" ");
    const input = `<input class="input" ${common} type="${esc(field.type || "text")}" value="${esc(value)}" placeholder="${esc(field.placeholder || "")}" ${attrs}>`;
    control = field.prefix || field.suffix
      ? `<div class="input-adorn ${field.prefix ? "has-prefix" : ""}">${field.prefix ? `<span class="adorn-prefix">${esc(field.prefix)}</span>` : ""}${input}${field.suffix ? `<span class="adorn-suffix">${esc(field.suffix)}</span>` : ""}</div>`
      : input;
  }
  return `<div class="field ${field.full ? "field-full" : ""}" data-field="${name}">
    ${label}${control}${help}
  </div>`;
}

export function fieldsHTML(fields, values = {}) {
  return (fields || []).map((field) => fieldHTML(field, values)).join("");
}

function collectValues(form, fields) {
  const values = {};
  for (const field of fields) {
    if (field.type === "static" || field.type === "custom") continue;
    if (field.type === "checkbox") {
      values[field.name] = Boolean(form.elements.namedItem(field.name)?.checked);
      continue;
    }
    const element = form.elements.namedItem(field.name);
    if (!element) continue;
    let value = element.value;
    if (typeof value === "string" && field.type !== "password" && !field.preserveWhitespace) {
      value = value.trim();
    }
    values[field.name] = value;
  }
  return values;
}

export function openForm({
  title,
  subtitle = "",
  eyebrow = "Formulir",
  fields = [],
  values = {},
  submitLabel = "Simpan",
  submitIcon = "check",
  cancelLabel = "Batal",
  danger = false,
  size = "md",
  intro = "",
  onSubmit,
  successMessage = "",
  dismissible = true,
  onMount,
}) {
  let modal = null;
  const body = `
    ${intro ? `<div class="form-intro">${intro}</div>` : ""}
    <form class="form-grid" id="generic-form" novalidate>
      ${fieldsHTML(fields, values)}
      <div class="form-error" hidden></div>
    </form>`;
  const footer = `<button class="btn btn-ghost" type="button" data-layer-close>${esc(cancelLabel)}</button>
    <button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="submit" form="generic-form" data-submit>
      ${icon(submitIcon, 16)} <span>${esc(submitLabel)}</span>
    </button>`;
  modal = openModal({
    title,
    subtitle,
    eyebrow,
    body,
    footer,
    size,
    dismissible,
    onMount,
  });
  const form = modal.rootEl.querySelector("#generic-form");
  const errorBox = form.querySelector(".form-error");
  const submitButton = modal.rootEl.querySelector("[data-submit]");
  const submitMarkup = submitButton.innerHTML;
  let busy = false;

  const setBusy = (state) => {
    busy = state;
    submitButton.disabled = state;
    submitButton.innerHTML = state
      ? `<span class="spinner spinner-xs"></span><span>Memproses…</span>`
      : submitMarkup;
  };
  const showError = (message) => {
    errorBox.innerHTML = `<span>${icon("alert", 16)}</span><div>${esc(message)}</div>`;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    errorBox.hidden = true;
    if (!form.reportValidity()) return;
    const collected = collectValues(form, fields);
    setBusy(true);
    try {
      const result = await onSubmit?.(collected, {
        form,
        modal,
        setBusy,
        showError,
        close: () => modal.close(),
      });
      if (result === false) {
        setBusy(false);
        return;
      }
      modal.close();
      if (successMessage) toast.success(successMessage);
    } catch (error) {
      setBusy(false);
      showError(error?.message || "Data belum dapat disimpan.");
    }
  });
  return modal;
}

export function confirmDialog({
  title = "Konfirmasi",
  message = "",
  eyebrow = "Konfirmasi",
  confirmLabel = "Ya, lanjutkan",
  cancelLabel = "Batal",
  danger = false,
  requireText = "",
  requirePassword = false,
  details = "",
  iconName = "alert",
}) {
  return new Promise((resolve) => {
    let settled = false;
    const inputFields = [];
    if (requireText) {
      inputFields.push({
        name: "confirmation",
        label: `Ketik ${requireText} untuk melanjutkan`,
        type: "text",
        required: true,
        placeholder: requireText,
        autofocus: true,
        help: "Konfirmasi ini mencegah tindakan yang tidak disengaja.",
      });
    }
    if (requirePassword) {
      inputFields.push({
        name: "password",
        label: "Password akun Anda",
        type: "password",
        required: true,
        autofocus: !requireText,
        help: "Diverifikasi oleh server sebelum tindakan dijalankan.",
      });
    }
    const formHTML = inputFields.length
      ? `<form id="confirm-form" class="form-grid">${fieldsHTML(inputFields, {})}<div class="form-error" hidden></div></form>`
      : "";
    const body = `<div class="confirm-body">
      <p class="confirm-message">${esc(message)}</p>
      ${details ? `<div class="confirm-details">${details}</div>` : ""}
      ${formHTML}
    </div>`;
    const footer = `<button class="btn btn-ghost" type="button" data-layer-close>${esc(cancelLabel)}</button>
      <button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="button" data-confirm>
        ${icon(danger ? "alert" : "check", 16)} <span>${esc(confirmLabel)}</span>
      </button>`;
    const modal = openModal({
      title,
      eyebrow,
      body,
      footer,
      size: "sm",
      iconName,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve({ confirmed: false });
        }
      },
    });
    const form = modal.rootEl.querySelector("#confirm-form");
    const confirmButton = modal.rootEl.querySelector("[data-confirm]");
    const errorBox = form?.querySelector(".form-error");
    confirmButton.addEventListener("click", () => {
      if (form && !form.reportValidity()) return;
      const values = form ? collectValues(form, inputFields) : {};
      settled = true;
      modal.close();
      resolve({ confirmed: true, ...values });
    });
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      confirmButton.click();
    });
  });
}

/* ------------------------------------------------------------------ buttons / misc */

export function setBusy(button, busy, busyLabel = "Memproses…") {
  if (!button) return;
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner-xs"></span><span>${esc(busyLabel)}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.original) button.innerHTML = button.dataset.original;
    delete button.dataset.original;
  }
}

export function printPage() {
  document.body.classList.add("print-mode");
  window.print();
  window.setTimeout(() => document.body.classList.remove("print-mode"), 700);
}

export function statCard({ label, value, sub = "", iconName = "chart", tone = "green", raw = false }) {
  return `<article class="stat-card stat-${esc(tone)}">
    <div class="stat-top"><span class="stat-icon">${icon(iconName, 19)}</span><span class="stat-label">${esc(label)}</span></div>
    <strong class="stat-value">${raw ? value : esc(value)}</strong>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ""}
  </article>`;
}

export function segmented(choices, active, name = "seg") {
  return `<div class="segmented" data-seg="${esc(name)}">${choices.map((choice) => {
    const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
    return `<button type="button" class="${String(active) === String(value) ? "is-active" : ""}" data-value="${esc(value)}">${esc(label)}</button>`;
  }).join("")}</div>`;
}
