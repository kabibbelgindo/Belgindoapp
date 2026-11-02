import { api, ApiError, firestoreHealth } from "./api.js";
import { icon } from "./icons.js";
import {
  closeAllLayers, emptyState, errorState, esc, fmtDate, fmtDateFull, fmtMonth,
  openForm, openModal, toast,
} from "./ui.js";
import {
  appInfo, currentUser, isAdmin, isPrimary, navigate, parseRoute, refreshMeta,
  setMeta, setSessionPayload, state,
} from "./state.js";
/* Modul halaman dimuat saat dibutuhkan (lazy) agar layar buka tidak menunggu
   seluruh berkas JS halaman terunduh dan dievaluasi lebih dulu. */
import { downloadExport, setPageChrome } from "./pages/common.js";
import { consoleFirestoreUrl, FIRESTORE_RULES_TEXT, setupGuide } from "./firestore-setup.js";

const appRoot = document.getElementById("app");

/* Input operasional disimpan konsisten dalam huruf kapital. Username,
   password, serta field konfigurasi Firebase tidak disentuh karena nilainya
   peka huruf besar-kecil. Event delegation mencakup form/modal dinamis. */
function isUppercaseExcluded(element) {
  const type = String(element.getAttribute("type") || "text").toLowerCase();
  if (element.tagName !== "TEXTAREA" && !["text", "search", "tel", "url", "email"].includes(type)) return true;
  const identity = `${element.name || ""} ${element.id || ""} ${element.autocomplete || ""}`.toLowerCase();
  return /user(name)?|password|passcode|firebase|database|apikey|authdomain|projectid|storagebucket|messagingsenderid|appid|measurementid|config/.test(identity);
}
function uppercaseTextValue(element) {
  if (isUppercaseExcluded(element) || element.readOnly || element.disabled) return;
  const start = element.selectionStart;
  const end = element.selectionEnd;
  const value = String(element.value || "");
  const upper = value.toUpperCase();
  if (value === upper) return;
  element.value = upper;
  if (start !== null && end !== null) element.setSelectionRange(start, end);
}
document.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) uppercaseTextValue(event.target);
}, true);
document.addEventListener("submit", (event) => {
  event.target.querySelectorAll?.("input, textarea").forEach(uppercaseTextValue);
}, true);
let clockTimer = null;
let currentCleanup = null;
let currentRouteKey = "";
let shellMounted = false;
let userMenuOpen = false;
let routeLock = false;

const NAV = [
  { group: "Ringkasan", items: [{ path: "/dashboard", label: "Dasbor", icon: "dashboard" }] },
  {
    group: "Penerimaan",
    items: [
      { path: "/receiving", label: "Penerimaan Lokal", icon: "inbox" },
      { path: "/imports", label: "Penerimaan Impor", icon: "import" },
      { path: "/tally", label: "Tally & Afkir", icon: "tally", badge: () => state.meta?.counts?.active_tallies },
      { path: "/recap", label: "Rekap Pembayaran", icon: "receipt", badge: () => state.meta?.counts?.active_recaps },
    ],
  },
  {
    group: "Gudang",
    items: [
      { path: "/stock", label: "Stok & Lot", icon: "package" },
      { path: "/outgoing", label: "Barang Keluar", icon: "outgoing" },
      { path: "/transfers", label: "Mutasi Lokasi", icon: "transfer" },
      { path: "/stock-card", label: "Kartu Stok", icon: "clipboard" },
    ],
  },
  {
    group: "Pengawasan",
    items: [
      { path: "/opname", label: "Stok Opname", icon: "history", dot: () => Boolean(state.meta?.period?.unclosed) },
      { path: "/reports", label: "Laporan & Ekspor", icon: "chart" },
    ],
  },
  {
    group: "Administrasi",
    admin: true,
    items: [
      { path: "/master/products", label: "Data Master", icon: "database", match: "/master" },
      { path: "/users", label: "Pengguna", icon: "users" },
      { path: "/activity", label: "Log Aktivitas", icon: "pulse" },
      { path: "/sync", label: "Sinkronisasi", icon: "refresh" },
      { path: "/backup", label: "Backup & Reset", icon: "shield" },
    ],
  },
];

const ROUTES = [
  { key: "dashboard", path: "/dashboard", load: () => import("./pages/dashboard.js"), title: "Dasbor", subtitle: "Ringkasan operasional gudang", admin: false },
  { key: "receiving", path: "/receiving", load: () => import("./pages/receiving.js"), title: "Penerimaan Lokal", subtitle: "Penjual, rit, dan nota barang masuk", admin: false },
  { key: "imports", path: "/imports", load: () => import("./pages/imports.js"), title: "Penerimaan Impor", subtitle: "Barcode, dokumen, dan lot kayu impor", admin: false },
  { key: "tally", path: "/tally", load: () => import("./pages/tally.js"), title: "Tally & Afkir", subtitle: "Pemeriksaan mutu barang masuk", admin: false },
  { key: "recap", path: "/recap", load: () => import("./pages/recap.js"), title: "Rekap Pembayaran", subtitle: "Tagihan pembelian per nota", admin: false },
  { key: "stock", path: "/stock", load: () => import("./pages/stock.js"), title: "Stok & Lot", subtitle: "Posisi persediaan dan lot aktif", admin: false },
  { key: "outgoing", path: "/outgoing", load: () => import("./pages/outgoing.js"), title: "Barang Keluar", subtitle: "Pengeluaran stok dari lot", admin: false },
  { key: "transfers", path: "/transfers", load: () => import("./pages/transfers.js"), title: "Mutasi Lokasi", subtitle: "Perpindahan barang antar gudang", admin: false },
  { key: "stock-card", path: "/stock-card", load: () => import("./pages/stockcard.js"), title: "Kartu Stok", subtitle: "Riwayat mutasi per barang", admin: false },
  { key: "opname", path: "/opname", load: () => import("./pages/opname.js"), title: "Stok Opname", subtitle: "Penghitungan fisik dan penyesuaian", admin: false },
  { key: "reports", path: "/reports", load: () => import("./pages/reports.js"), title: "Laporan & Ekspor", subtitle: "Analitik dan unduhan data", admin: false },
  { key: "master", path: "/master/products", load: () => import("./pages/master.js"), title: "Data Master", subtitle: "Barang, penjual, lokasi, ukuran, dan harga", admin: true },
  { key: "users", path: "/users", load: () => import("./pages/users.js"), title: "Pengguna", subtitle: "Akun dan hak akses", admin: true },
  { key: "activity", path: "/activity", load: () => import("./pages/activity.js"), title: "Log Aktivitas", subtitle: "Jejak audit seluruh pengguna", admin: true },
  { key: "sync", path: "/sync", load: () => import("./pages/sync.js"), title: "Sinkronisasi", subtitle: "Status outbox dan riwayat data", admin: true },
  { key: "backup", path: "/backup", load: () => import("./pages/backup.js"), title: "Backup & Reset", subtitle: "Cadangkan dan bersihkan data transaksi", admin: true },
];

function findRouteDefinition(route) {
  const rawSegment = route.segment[0] || "dashboard";
  const isCountRoute = rawSegment === "opname" && route.segment[1] && /^\d+$/.test(route.segment[1]);
  return ROUTES.find((item) => {
    if (isCountRoute) return item.key === "opname";
    if (item.key === "master") return rawSegment === "master";
    return rawSegment === item.key;
  });
}

function loadRouteModule(definition) {
  if (definition.module) return Promise.resolve(definition.module);
  if (!definition.modulePromise) {
    definition.modulePromise = Promise.resolve(definition.load())
      .then((module) => {
        definition.module = module;
        return module;
      })
      .catch((error) => {
        definition.modulePromise = null;
        throw error;
      });
  }
  return definition.modulePromise;
}

/* Layar pembuka ditampilkan hanya saat aplikasi belum siap, lalu dihapus dari DOM. */
let bootScreenHidden = false;
function hideBootScreen() {
  if (bootScreenHidden) return;
  bootScreenHidden = true;
  const node = document.getElementById("boot-screen");
  if (!node) return;
  node.classList.add("is-done");
  window.setTimeout(() => node.remove(), 280);
}

function activeNavPath(path) {
  const clean = String(path || "").split("?")[0];
  const exact = NAV.flatMap((group) => group.items).find((item) => item.match && clean.startsWith(item.match));
  if (exact) return exact.path;
  return clean;
}

function brandMarkup({ compact = false } = {}) {
  return `<a class="brand-lockup" href="#/dashboard" aria-label="PT. Belgindo Raya Inventory — Dasbor">
    <span class="brand-mark">BR</span>
    <span class="brand-text"><strong>PT. BELGINDO RAYA</strong><span>INVENTORY</span></span>
  </a>`;
}

function periodCard() {
  const period = state.meta?.period || {};
  const locked = state.meta?.lock?.locked_through;
  const range = period.last_closed_display
    ? `${period.last_closed_display}`
    : "Belum ada penutupan";
  return `<div class="period-card">
    <span class="label">${icon("calendar", 12)} ${locked ? "Periode terkunci" : "Periode berjalan"}</span>
    <strong>${locked ? `s.d. ${esc(state.meta?.lock?.locked_through_display || fmtDate(locked))}` : esc(period.start_display || "Sejak awal data")}</strong>
    <small>${locked ? `Penutupan terakhir ${esc(range)}` : "Belum ada periode yang ditutup"}</small>
  </div>`;
}

function navMarkup() {
  return NAV.map((group) => {
    if (group.admin && !isAdmin()) return "";
    return `<div class="nav-group">
      <span class="nav-label">${esc(group.group)}</span>
      ${group.items.map((item) => {
        const badgeValue = item.badge ? Number(item.badge() || 0) : 0;
        const dot = item.dot ? Boolean(item.dot()) : false;
        return `<a class="nav-item" href="#${esc(item.path)}" data-nav-path="${esc(item.path)}" data-nav-match="${esc(item.match || "")}">
          ${icon(item.icon, 18)}<span class="nav-text">${esc(item.label)}</span>
          ${badgeValue ? `<span class="nav-badge">${badgeValue}</span>` : dot ? '<span class="nav-dot" title="Ada opname belum ditutup"></span>' : ""}
        </a>`;
      }).join("")}
    </div>`;
  }).join("");
}

function shellMarkup() {
  const user = currentUser() || {};
  const app = appInfo();
  const locked = state.meta?.lock?.locked_through;
  return `<div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="Navigasi utama">
      <div class="sidebar-head">
        ${brandMarkup()}
        <button class="icon-btn sidebar-close" type="button" data-sidebar-close aria-label="Tutup menu">${icon("x", 18)}</button>
      </div>
      <div class="sidebar-scroll">${navMarkup()}</div>
      <div class="sidebar-foot">
        ${periodCard()}
        <div class="sidebar-version"><span>Belgindo Inventory · v${esc(app.version || "1.0.99")}</span><span>FIREBASE</span></div>
      </div>
    </aside>
    <div class="sidebar-scrim" data-sidebar-close></div>
    <div class="app-main">
      <header class="topbar">
        <div class="topbar-left">
          <button class="icon-btn mobile-menu-btn" type="button" data-sidebar-open aria-label="Buka menu">${icon("menu", 20)}</button>
          <div class="page-title-block">
            <span class="page-eyebrow" id="topbar-eyebrow">PT. BELGINDO RAYA INVENTORY</span>
            <div class="page-title" id="topbar-title">Dasbor</div>
            <div class="page-subtitle" id="topbar-subtitle">Ringkasan operasional gudang</div>
          </div>
        </div>
        <div class="topbar-actions">
          <button class="search-trigger" type="button" data-palette-open aria-label="Cari menu (Ctrl K)">
            ${icon("search", 16)}<span class="search-label">Cari menu…</span><span class="kbd">Ctrl K</span>
          </button>
          <a class="lock-chip ${locked ? "is-locked" : ""}" href="#/opname" title="${locked ? "Periode dikunci oleh opname" : "Tidak ada penguncian periode"}">
            ${icon(locked ? "lock" : "checkCircle", 14)}<span class="lock-text">${locked ? `Terkunci s.d. ${esc(state.meta?.lock?.locked_through_display || fmtDate(locked))}` : "Periode terbuka"}</span>
          </a>
          <div class="topbar-divider"></div>
          <button class="icon-btn" type="button" data-refresh-page aria-label="Muat ulang halaman" title="Muat ulang halaman">${icon("refresh", 18)}</button>
          <div class="clock-block"><strong id="clock-time">--:--</strong><span id="clock-date">—</span></div>
          <div class="popover-wrap" data-user-menu>
            <button class="user-button" type="button" data-user-toggle aria-expanded="false" aria-haspopup="menu">
              <span class="avatar">${esc(initials(user.full_name || user.username || "?"))}</span>
              <span class="user-copy"><strong>${esc(user.full_name || user.username || "Pengguna")}</strong><span>${esc(user.role === "admin" ? "Administrator" : "Petugas gudang")}</span></span>
              ${icon("chevronDown", 14, "chev")}
            </button>
            <div class="popover" hidden data-user-popover role="menu">
              <div class="popover-head"><strong>${esc(user.full_name || user.username || "Pengguna")}</strong><span>@${esc(user.username || "-")}${user.is_primary_admin ? " · Admin Utama" : ""}</span></div>
              <button class="popover-item" type="button" data-change-password>${icon("key", 16)} Ganti Password</button>
              ${isAdmin() ? `<button class="popover-item" type="button" data-open-activity>${icon("pulse", 16)} Log Aktivitas</button>` : ""}
              <button class="popover-item danger" type="button" data-logout>${icon("logout", 16)} Keluar</button>
            </div>
          </div>
        </div>
      </header>
      <main class="view" id="view" tabindex="-1"></main>
      <footer class="app-footer">
        <span>Sistem Inventori Kayu <span class="dotsep">•</span> PT. BELGINDO RAYA INVENTORY</span>
        <span>${esc(app.edition || "Edisi gudang")} <span class="dotsep">•</span> v${esc(app.version || "1.0.99")}</span>
      </footer>
    </div>
    <nav class="mobile-nav" aria-label="Navigasi cepat">
      ${mobileNavMarkup()}
    </nav>
  </div>`;
}

function mobileNavMarkup() {
  const items = [
    { path: "/dashboard", label: "Dasbor", icon: "dashboard" },
    { path: "/receiving", label: "Terima", icon: "inbox" },
    { path: "/stock", label: "Stok", icon: "package" },
    { path: "/opname", label: "Opname", icon: "history" },
  ];
  return items.map((item) => `<a href="#${item.path}" data-nav-path="${item.path}">${icon(item.icon, 19)}<span>${esc(item.label)}</span></a>`).join("")
    + `<button type="button" data-sidebar-open>${icon("menu", 19)}<span>Lainnya</span></button>`;
}

function initials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function updateNavActive(path) {
  const target = activeNavPath(path);
  document.querySelectorAll("[data-nav-path]").forEach((link) => {
    const own = link.dataset.navPath;
    const match = link.dataset.navMatch;
    const active = match ? String(path).startsWith(match) : own === target || (own === "/opname" && String(path).startsWith("/opname"));
    link.classList.toggle("is-active", active);
  });
}

function updateClock() {
  const timeEl = document.getElementById("clock-time");
  const dateEl = document.getElementById("clock-date");
  if (!timeEl || !dateEl) return;
  const now = new Date();
  timeEl.textContent = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  dateEl.textContent = now.toLocaleDateString("id-ID", { weekday: "short", day: "numeric", month: "short" });
}

function applyPageChrome() {
  const page = state.page || {};
  setPageChrome(page);
  updateNavActive(location.hash ? parseRoute().path : "/dashboard");
}

function closeUserMenu() {
  const popover = document.querySelector("[data-user-popover]");
  const toggle = document.querySelector("[data-user-toggle]");
  if (popover) popover.hidden = true;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  userMenuOpen = false;
}

function bindShellEvents() {
  document.querySelectorAll("[data-sidebar-open]").forEach((button) => {
    button.addEventListener("click", () => {
      document.body.classList.add("sidebar-open");
      closeUserMenu();
    });
  });
  document.querySelectorAll("[data-sidebar-close]").forEach((node) => {
    node.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  });
  document.querySelectorAll("[data-nav-path]").forEach((link) => {
    link.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  });
  document.querySelector("[data-palette-open]")?.addEventListener("click", () => openPalette());
  document.querySelector("[data-refresh-page]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.style.opacity = "0.55";
    try {
      await refreshMeta().catch(() => null);
      updateSidebar();
      await renderRoute({ silent: true });
      toast.info("Halaman dimuat ulang.");
    } finally {
      button.disabled = false;
      button.style.opacity = "";
    }
  });
  const toggle = document.querySelector("[data-user-toggle]");
  toggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    const popover = document.querySelector("[data-user-popover]");
    if (!popover) return;
    userMenuOpen = !userMenuOpen;
    popover.hidden = !userMenuOpen;
    toggle.setAttribute("aria-expanded", userMenuOpen ? "true" : "false");
  });
  document.addEventListener("click", (event) => {
    if (userMenuOpen && !event.target.closest("[data-user-menu]")) closeUserMenu();
  });
  document.querySelector("[data-change-password]")?.addEventListener("click", () => {
    closeUserMenu();
    openChangePassword();
  });
  document.querySelector("[data-open-activity]")?.addEventListener("click", () => {
    closeUserMenu();
    navigate("/activity");
  });
  document.querySelector("[data-logout]")?.addEventListener("click", async () => {
    closeUserMenu();
    try {
      await api.post("/api/auth/logout", {});
    } catch {
      /* sesi mungkin sudah berakhir */
    }
    teardownShell();
    renderLogin("Anda telah keluar dari PT. Belgindo Raya Inventory.");
  });
  updateClock();
  if (clockTimer) window.clearInterval(clockTimer);
  clockTimer = window.setInterval(updateClock, 15000);
}

function updateSidebar() {
  const scroll = document.querySelector(".sidebar-scroll");
  if (scroll) scroll.innerHTML = navMarkup();
  const foot = document.querySelector(".sidebar-foot");
  if (foot) foot.innerHTML = `${periodCard()}<div class="sidebar-version"><span>Belgindo Inventory · v${esc(appInfo().version || "1.0.99")}</span><span>FIREBASE</span></div>`;
  document.querySelectorAll("[data-nav-path]").forEach((link) => {
    link.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  });
  const chip = document.querySelector(".lock-chip");
  if (chip) {
    const locked = state.meta?.lock?.locked_through;
    chip.className = `lock-chip ${locked ? "is-locked" : ""}`;
    chip.innerHTML = `${icon(locked ? "lock" : "checkCircle", 14)}<span class="lock-text">${locked ? `Terkunci s.d. ${esc(state.meta?.lock?.locked_through_display || fmtDate(locked))}` : "Periode terbuka"}</span>`;
  }
  updateNavActive(parseRoute().path);
}

function teardownShell() {
  if (typeof currentCleanup === "function") {
    try {
      currentCleanup();
    } catch {
      /* abaikan pembersihan halaman */
    }
  }
  currentCleanup = null;
  if (clockTimer) window.clearInterval(clockTimer);
  clockTimer = null;
  closeAllLayers();
  shellMounted = false;
  currentRouteKey = "";
  document.body.classList.remove("sidebar-open");
  if (appRoot) appRoot.innerHTML = "";
}

async function boot() {
  if (!appRoot) return;
  /* Unduh modul rute awal secara paralel dengan permintaan sesi. */
  findRouteDefinition(parseRoute())?.load();
  /* Sesi, meta, dan kesehatan Firestore diambil serentak agar layar buka tetap cepat. */
  const sessionPromise = api.request("/api/auth/session", { quietAuth: true }).catch((error) => ({ __error: error }));
  const metaPromise = refreshMeta().catch((error) => ({ __error: error }));
  const healthPromise = firestoreHealth().catch(() => null);
  /* Kesehatan Firestore diputuskan lebih dahulu: bila database/aturan belum
     siap, layar penyiapan tampil seketika tanpa menunggu galat muat data. */
  const health = await healthPromise;
  if (health && health.ok === false) {
    hideBootScreen();
    renderSetupRequired(health);
    return;
  }
  const session = await sessionPromise;
  if (session?.__error) {
    const error = session.__error;
    hideBootScreen();
    if (error instanceof ApiError && error.status === 401) renderLogin();
    else renderLogin(error?.message ? `Tidak dapat memuat sesi: ${error.message}` : "");
    return;
  }
  setSessionPayload(session);
  let meta = await metaPromise;
  if (meta?.__error) meta = await refreshMeta().catch(() => null);
  if (!meta) {
    hideBootScreen();
    renderLogin("Tidak dapat memuat pengaturan awal. Muat ulang halaman, lalu masuk kembali.");
    return;
  }
  hideBootScreen();
  renderShell();
  await renderRoute();
}

/* ------------------------------------------------------------------ auth */

function authBrandMarkup() {
  const app = appInfo();
  return `<section class="auth-brand">
    <div class="auth-top">
      ${brandMarkup()}
      <span class="auth-edition">${esc(app.edition || "Edisi inventori kayu")}</span>
    </div>
    <div class="auth-hero">
      <span class="auth-kicker"><span class="rule"></span> Ruang kerja gudang kayu</span>
      <h1>Setiap batang<br>tercatat dengan <em>tenang.</em></h1>
      <p>PT. Belgindo Raya Inventory menyatukan penerimaan, tally, persediaan, opname, dan pembayaran dalam satu alur kerja yang jernih — dirancang untuk ritme gudang nyata.</p>
      <div class="auth-features">
        <span class="auth-feature">${icon("inbox", 14)} Penerimaan &amp; rit</span>
        <span class="auth-feature">${icon("tally", 14)} Tally fresh / afkir</span>
        <span class="auth-feature">${icon("package", 14)} Stok per lot</span>
        <span class="auth-feature">${icon("history", 14)} Opname berurutan</span>
      </div>
    </div>
    <div class="auth-foot">
      <span>© ${new Date().getFullYear()} PT. BELGINDO RAYA INVENTORY</span>
      <span>v${esc(app.version || "1.0.99")} · Data tersimpan di Firestore</span>
    </div>
  </section>`;
}

function renderLogin(notice = "") {
  hideBootScreen();
  teardownShell();
  document.title = "Masuk · PT. Belgindo Raya Inventory";
  appRoot.innerHTML = `<div class="auth">
    ${authBrandMarkup()}
    <section class="auth-side">
      <div class="brand-lockup">
        <span class="brand-mark">BR</span>
        <span class="brand-text"><strong style="color:var(--ink)">PT. BELGINDO RAYA</strong><span style="color:var(--muted)">INVENTORY</span></span>
      </div>
      <div class="auth-card">
        <span class="eyebrow">Selamat datang kembali</span>
        <h2>Masuk ke ruang kerja</h2>
        <p>Gunakan akun yang diberikan administrator untuk mengelola penerimaan, stok, dan laporan gudang.</p>
        <form class="auth-form" id="login-form" novalidate>
          <div class="field">
            <label class="field-label" for="login-username">Username</label>
            <input class="input" id="login-username" name="username" type="text" autocomplete="username" spellcheck="false" autofocus placeholder="Username akun">
          </div>
          <div class="field">
            <label class="field-label" for="login-password">Password</label>
            <div class="input-adorn">
              <input class="input input-password" id="login-password" name="password" type="password" autocomplete="current-password" placeholder="Password akun">
              <button class="password-toggle" type="button" data-toggle-password="login-password" aria-label="Tampilkan password">${icon("eye", 17)}</button>
            </div>
          </div>
          <div class="auth-error" id="login-error" hidden></div>
          <button class="btn btn-primary auth-submit" type="submit" data-login-submit>${icon("arrowRight", 17)} <span>Masuk ke PT. Belgindo Raya Inventory</span></button>
        </form>
        <div class="auth-meta">
          <span>${icon("lock", 12)} Firestore • paket Spark</span>
          <span>v${esc(appInfo().version || "1.0.99")}</span>
        </div>
        ${notice ? `<div class="mt-16">${noticeMarkup(notice)}</div>` : ""}
      </div>
    </section>
  </div>`;
  bindPasswordToggles(appRoot);
  const form = document.getElementById("login-form");
  const errorBox = document.getElementById("login-error");
  const submit = form?.querySelector("[data-login-submit]");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    errorBox.hidden = true;
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    if (!username || !password) {
      errorBox.innerHTML = `${icon("alert", 16)}<div>Username dan password wajib diisi.</div>`;
      errorBox.hidden = false;
      return;
    }
    const original = submit.innerHTML;
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner spinner-xs"></span><span>Memeriksa akun…</span>`;
    try {
      const payload = await api.post("/api/auth/login", { username, password }, { quietAuth: true });
      setSessionPayload(payload);
      await refreshMeta();
      renderShell();
      await renderRoute();
      toast.success(`Selamat bekerja, ${currentUser()?.full_name || currentUser()?.username || "rekan"}.`);
    } catch (error) {
      /* Bila penyebabnya Firestore sendiri (database/aturan belum siap),
         tampilkan layar penyiapan alih-alih pesan login yang salah arah. */
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
        const health = await firestoreHealth().catch(() => null);
        if (health && health.ok === false) {
          renderSetupRequired(health);
          return;
        }
      }
      errorBox.innerHTML = `${icon("alert", 16)}<div>${esc(error.message || "Login gagal.")}</div>`;
      errorBox.hidden = false;
      form.elements.password.focus();
      form.elements.password.select();
    } finally {
      submit.disabled = false;
      submit.innerHTML = original;
    }
  });
}

function noticeMarkup(text) {
  return `<div class="banner banner-info"><span class="banner-icon">${icon("info", 17)}</span><div><p>${esc(text)}</p></div></div>`;
}

/* Layar penyiapan Firestore: muncul bila database belum dibuat, aturan
   keamanan belum diterbitkan, atau jaringan bermasalah — lengkap dengan
   langkah perbaikan di Firebase Console tanpa perlu CLI. */
function renderSetupRequired(status) {
  hideBootScreen();
  teardownShell();
  const guide = setupGuide(status);
  const app = appInfo();
  document.title = "Penyiapan Firestore · PT. Belgindo Raya Inventory";
  const stepsMarkup = guide.steps.map((step, index) => `
    <li class="setup-step">
      <span class="setup-step-no">${index + 1}</span>
      <div>
        <span class="setup-step-title">${step.title}</span>
        <ul>${step.items.map((item) => `<li>${item}</li>`).join("")}</ul>
      </div>
    </li>`).join("");
  appRoot.innerHTML = `<div class="setup-screen">
    <div class="setup-card">
      <div class="setup-head">
        <span class="setup-badge">${icon("alert", 15)} Penyiapan diperlukan</span>
        <h1>${esc(guide.headline)}</h1>
        <p>${guide.summary}</p>
      </div>
      ${stepsMarkup ? `<ol class="setup-steps">${stepsMarkup}</ol>` : ""}
      <div class="setup-actions">
        <a class="btn btn-primary" href="${esc(consoleFirestoreUrl(status.projectId))}" target="_blank" rel="noopener">${icon("external", 16)} <span>Buka Firebase Console</span></a>
        <button class="btn" type="button" data-copy-rules>${icon("clipboard", 16)} <span>Salin aturan</span></button>
        <button class="btn" type="button" data-recheck>${icon("refresh", 16)} <span>Periksa ulang</span></button>
      </div>
      <div class="setup-done" data-setup-done hidden>${icon("check", 15)} <span>Firestore siap! Memuat aplikasi…</span></div>
      <details class="setup-rules">
        <summary>${icon("database", 14)} Lihat isi aturan (firestore.rules)</summary>
        <pre>${esc(FIRESTORE_RULES_TEXT)}</pre>
      </details>
      <div class="setup-meta">
        <span>${icon("lock", 12)} Proyek: ${esc(status.projectId)}</span>
        <span>v${esc(app.version || "1.0.99")} · ${esc(app.edition || "Firebase Cloud")}</span>
      </div>
    </div>
  </div>`;
  const copyButton = appRoot.querySelector("[data-copy-rules]");
  copyButton?.addEventListener("click", async () => {
    const copied = await copyText(FIRESTORE_RULES_TEXT);
    toast.success(copied ? "Aturan disalin. Tempel di tab Rules lalu Publish." : "Gagal menyalin — salin manual dari kotak aturan di bawah.");
  });
  appRoot.querySelector("[data-recheck]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner-xs"></span><span>Memeriksa…</span>`;
    const health = await firestoreHealth().catch(() => null);
    if (health?.ok) {
      const done = appRoot.querySelector("[data-setup-done]");
      if (done) done.hidden = false;
      window.setTimeout(() => window.location.reload(), 700);
      return;
    }
    button.disabled = false;
    button.innerHTML = original;
    if (health) toast.error(health.message || "Firestore belum siap.");
    else toast.error("Pemeriksaan gagal. Periksa koneksi internet.");
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function bindPasswordToggles(root) {
  root.querySelectorAll("[data-toggle-password]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.togglePassword);
      if (!input) return;
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.innerHTML = icon(reveal ? "eyeOff" : "eye", 17);
      button.setAttribute("aria-label", reveal ? "Sembunyikan password" : "Tampilkan password");
      input.focus({ preventScroll: true });
    });
  });
}

function openChangePassword() {
  const modal = openForm({
    title: "Ganti password",
    eyebrow: "Keamanan akun",
    subtitle: "Gunakan password yang tidak dipakai di tempat lain.",
    fields: [
      { name: "old_password", label: "Password lama", type: "password", required: true, autofocus: true },
      { name: "new_password", label: "Password baru", type: "password", required: true, minlength: 6, help: "Minimal 6 karakter dan berbeda dari password lama." },
      { name: "confirm_password", label: "Ulangi password baru", type: "password", required: true, full: true },
    ],
    submitLabel: "Simpan password",
    submitIcon: "key",
    onSubmit: async (values) => {
      if (values.new_password !== values.confirm_password) {
        throw new Error("Konfirmasi password baru belum sama.");
      }
      await api.post("/api/auth/change-password", values, { quietAuth: true });
      toast.success("Password berhasil diganti.");
      refreshMeta().catch(() => {});
    },
  });
  return modal;
}

/* ------------------------------------------------------------------ shell */

function renderShell() {
  teardownShell();
  appRoot.innerHTML = shellMarkup();
  shellMounted = true;
  bindShellEvents();
  applyPageChrome();
}

async function renderRoute({ silent = false } = {}) {
  if (!shellMounted) return;
  if (routeLock) return;
  routeLock = true;
  const view = document.getElementById("view");
  if (!view) {
    routeLock = false;
    return;
  }
  const route = parseRoute();
  const routeKey = route.raw;
  const definition = findRouteDefinition(route);
  if (typeof currentCleanup === "function") {
    try {
      currentCleanup();
    } catch {
      /* abaikan */
    }
  }
  currentCleanup = null;
  closeAllLayers();
  document.body.classList.remove("sidebar-open");
  closeUserMenu();
  currentRouteKey = routeKey;
  if (!definition) {
    view.innerHTML = `<div class="page-head"><div><h1>Halaman tidak ditemukan</h1><p>Alamat yang Anda buka tidak tersedia di PT. Belgindo Raya Inventory.</p></div></div>
      <div class="card">${emptyState({ iconName: "help", title: "Tidak ada halaman di sini", text: "Periksa kembali tautan atau kembali ke dasbor.", action: '<a class="btn btn-primary" href="#/dashboard">Ke dasbor</a>' })}</div>`;
    state.page = { title: "Tidak ditemukan", subtitle: "", eyebrow: "PT. BELGINDO RAYA INVENTORY", actions: [] };
    applyPageChrome();
    routeLock = false;
    return;
  }
  if (definition.admin && !isAdmin()) {
    view.innerHTML = `<div class="page-head"><div><span class="eyebrow">Akses terbatas</span><h1>Halaman khusus administrator</h1><p>Akun Anda tidak memiliki hak akses untuk membuka halaman ini.</p></div></div>
      <div class="card">${emptyState({ iconName: "lock", title: "Akses ditolak", text: "Hubungi administrator bila Anda memerlukan akses ke bagian ini.", action: '<a class="btn btn-secondary" href="#/dashboard">Kembali ke dasbor</a>' })}</div>`;
    state.page = { title: definition.title, subtitle: definition.subtitle, eyebrow: "Administrasi", actions: [] };
    applyPageChrome();
    routeLock = false;
    return;
  }
  state.page = { title: definition.title, subtitle: definition.subtitle, eyebrow: "PT. BELGINDO RAYA INVENTORY", actions: [] };
  applyPageChrome();
  view.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Menyiapkan ${esc(definition.title)}…</span></div>`;
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const module = await loadRouteModule(definition);
    const cleanup = await module.render(view, { route, rerender: () => renderRoute({ silent: false }), definition });
    currentCleanup = typeof cleanup === "function" ? cleanup : null;
  } catch (error) {
    view.innerHTML = `<div class="page-head"><div><h1>${esc(definition.title)}</h1></div></div>
      <div class="card card-pad">${errorState(error?.message || "Halaman gagal dimuat.")}</div>`;
    view.querySelector("[data-retry]")?.addEventListener("click", () => renderRoute({ silent: false }));
  } finally {
    updateNavActive(route.path);
    routeLock = false;
  }
}

/* ------------------------------------------------------------------ palette */

function paletteItems() {
  const items = [];
  for (const group of NAV) {
    if (group.admin && !isAdmin()) continue;
    for (const item of group.items) {
      items.push({ label: item.label, meta: group.group, icon: item.icon, path: item.path });
    }
  }
  if (canUseReceiving()) items.push({ label: "Buat rit baru", meta: "Penerimaan", icon: "plus", action: "new-rit" });
  if (canUseImports()) items.push({ label: "Pindai penerimaan impor", meta: "Impor", icon: "scan", path: "/imports?scan=1" });
  if (state.meta?.period && !state.meta.period.unclosed && isAdmin()) items.push({ label: "Mulai stok opname", meta: "Pengawasan", icon: "clipboard", path: "/opname?new=1" });
  if (isAdmin()) items.push({ label: "Unduh backup database", meta: "Administrasi", icon: "download", action: "backup" });
  return items;
}

function canUseReceiving() {
  return state.meta?.masters?.sellers?.length > 0;
}

function canUseImports() {
  return true;
}

function openPalette() {
  let highlighted = 0;
  let filtered = [];
  const body = `<div class="palette-box">
    <div class="palette-search">${icon("search", 18)}<input type="search" id="palette-input" placeholder="Cari halaman, data, atau tindakan…" autocomplete="off" autofocus><span class="kbd">Esc</span></div>
    <div class="palette-list" id="palette-list"></div>
    <div class="palette-foot"><span class="set"><span class="kbd">↑</span><span class="kbd">↓</span> jelajahi</span><span class="set"><span class="kbd">Enter</span> buka</span><span class="set">Belgindo Inventory</span></div>
  </div>`;
  const layer = openModal({ title: "", body, className: "palette", size: "lg" });
  const input = layer.rootEl.querySelector("#palette-input");
  const list = layer.rootEl.querySelector("#palette-list");
  const all = paletteItems();
  const renderList = () => {
    const term = input.value.trim().toLowerCase();
    filtered = all.filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(term));
    if (highlighted >= filtered.length) highlighted = Math.max(0, filtered.length - 1);
    if (!filtered.length) {
      list.innerHTML = `<div class="palette-empty">Tidak ada hasil untuk “${esc(input.value)}”.</div>`;
      return;
    }
    let lastGroup = "";
    const chunks = [];
    filtered.forEach((item, index) => {
      if (item.meta !== lastGroup) {
        chunks.push(`<div class="palette-group-label">${esc(item.meta)}</div>`);
        lastGroup = item.meta;
      }
      chunks.push(`<button class="palette-item ${index === highlighted ? "is-highlighted" : ""}" type="button" data-index="${index}">
        ${icon(item.icon, 17)}<span>${esc(item.label)}</span>${index === highlighted ? '<span class="pal-meta">↵ buka</span>' : ""}
      </button>`);
    });
    list.innerHTML = chunks.join("");
    list.querySelectorAll("[data-index]").forEach((button) => {
      button.addEventListener("click", () => choose(filtered[Number(button.dataset.index)]));
      button.addEventListener("mouseenter", () => {
        highlighted = Number(button.dataset.index);
        renderList();
      });
    });
  };
  const choose = (item) => {
    if (!item) return;
    layer.close();
    if (item.action === "new-rit") {
      navigate("/receiving");
      window.setTimeout(() => document.querySelector("[data-new-rit]")?.click(), 250);
      return;
    }
    if (item.action === "backup") {
      navigate("/backup");
      window.setTimeout(() => document.querySelector("[data-download-backup]")?.click(), 300);
      return;
    }
    navigate(item.path);
  };
  input.addEventListener("input", () => {
    highlighted = 0;
    renderList();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlighted = Math.min(filtered.length - 1, highlighted + 1);
      renderList();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlighted = Math.max(0, highlighted - 1);
      renderList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(filtered[highlighted]);
    }
  });
  renderList();
  layer.rootEl.querySelector("[data-close]")?.addEventListener("click", () => layer.close());
}

/* ------------------------------------------------------------------ global events */

window.addEventListener("hashchange", () => {
  if (shellMounted) renderRoute();
});
window.addEventListener("br:pagechange", () => applyPageChrome());
window.addEventListener("br:meta", () => {
  if (shellMounted) updateSidebar();
});
window.addEventListener("br:session-expired", () => {
  if (!shellMounted) return;
  teardownShell();
  setSessionPayload(null);
  setMeta(null);
  renderLogin("Sesi Anda telah berakhir. Silakan masuk kembali untuk melanjutkan.");
  toast.warn("Sesi berakhir. Silakan masuk kembali.");
});
document.addEventListener("keydown", (event) => {
  const key = String(event.key || "").toLowerCase();
  const meta = event.ctrlKey || event.metaKey;
  if (meta && key === "k") {
    event.preventDefault();
    if (shellMounted) openPalette();
  } else if (key === "escape" && userMenuOpen) {
    closeUserMenu();
  }
});
window.addEventListener("beforeunload", () => {
  if (typeof currentCleanup === "function") {
    try {
      currentCleanup();
    } catch {
      /* abaikan */
    }
  }
});

boot();
