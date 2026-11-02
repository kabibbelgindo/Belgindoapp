import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  badge, confirmDialog, emptyState, esc, fmtDate, fmtDateTime, initials, openForm,
  statCard, toast,
} from "../ui.js";
import { loadingCard } from "./common.js";
import { currentUser, permissions } from "../state.js";

const state = {
  root: null,
  users: [],
  search: "",
  seq: 0,
};

function me() {
  return currentUser() || {};
}

function canManage() {
  return Boolean(permissions().manage_users);
}

function roleBadge(user) {
  if (user.is_primary_admin) return badge("Admin Utama", "blue");
  return user.role === "admin" ? badge("Admin", "green") : badge("Pengguna", "neutral");
}

function visibleUsers() {
  const term = state.search.trim().toLowerCase();
  if (!term) return state.users;
  return state.users.filter((user) =>
    `${user.username} ${user.full_name || ""} ${user.role}`.toLowerCase().includes(term));
}

function userCard(user) {
  const self = Number(user.id) === Number(me().id) || user.is_self;
  const name = user.full_name || user.username;
  return `<div class="user-card ${user.active ? "" : "is-inactive"}" data-user-row data-context-edit="[data-user-action=edit][data-id='${user.id}']" data-context-delete="[data-user-action=delete][data-id='${user.id}']">
    <div class="avatar">${esc(initials(name))}</div>
    <div class="user-copy-main">
      <div class="user-name-line">
        <strong>${esc(name)}</strong>
        <span class="user-handle">@${esc(user.username)}</span>
        ${roleBadge(user)}
        ${self ? badge("Anda", "neutral") : ""}
        ${user.active ? "" : badge("Nonaktif", "red")}
      </div>
      <div class="user-meta">
        <span>${icon("clock", 11)} Login terakhir ${esc(user.last_login ? fmtDateTime(user.last_login) : "belum pernah")}</span>
        <span>${icon("calendar", 11)} Dibuat ${esc(fmtDate(user.created_at))}</span>
      </div>
    </div>
    <div class="user-actions">
      <button class="icon-btn" type="button" title="Ubah pengguna" data-user-action="edit" data-id="${user.id}">${icon("edit", 16)}</button>
      ${!self && canManage() ? `<button class="icon-btn" type="button" title="${user.active ? "Nonaktifkan" : "Aktifkan"} pengguna" data-user-action="toggle" data-id="${user.id}">${icon(user.active ? "eyeOff" : "eye", 16)}</button>` : ""}
      ${!self ? `<button class="icon-btn" type="button" title="Reset password" data-user-action="reset" data-id="${user.id}">${icon("key", 16)}</button>` : ""}
      ${!self ? `<button class="icon-btn" type="button" title="Hapus pengguna" data-user-action="delete" data-id="${user.id}">${icon("trash", 16)}</button>` : ""}
    </div>
  </div>`;
}

function renderCards() {
  const holder = state.root?.querySelector("#user-list");
  if (!holder) return;
  const rows = visibleUsers();
  holder.innerHTML = rows.length
    ? rows.map(userCard).join("")
    : `<div class="card">${emptyState({
      iconName: "users",
      title: state.search ? "Pengguna tidak ditemukan" : "Belum ada pengguna lain",
      text: state.search ? "Ubah kata kunci pencarian." : "Tambahkan akun untuk rekan kerja yang perlu mencatat penerimaan atau stok.",
    })}</div>`;
  const count = state.root?.querySelector("#user-count");
  if (count) count.textContent = `${rows.length} dari ${state.users.length} akun`;
  bindCards();
}

function bindCards() {
  state.root?.querySelectorAll("[data-user-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const user = state.users.find((row) => Number(row.id) === Number(button.dataset.id));
      if (!user) return;
      const action = button.dataset.userAction;
      if (action === "edit") openEditForm(user);
      else if (action === "toggle") toggleUser(user);
      else if (action === "reset") openResetForm(user);
      else if (action === "delete") deleteUser(user);
    });
  });
}

async function loadUsers() {
  const holder = state.root?.querySelector("#user-list");
  if (holder) holder.innerHTML = loadingCard("Memuat akun pengguna…");
  const seq = ++state.seq;
  try {
    const data = await api.get("/api/master/users");
    if (seq !== state.seq) return;
    state.users = data.users || [];
    renderStats();
    renderCards();
  } catch (error) {
    if (seq !== state.seq) return;
    if (holder) {
      holder.innerHTML = `<div class="card card-pad">${emptyState({
        iconName: "alert", title: "Pengguna gagal dimuat", text: error.message,
        action: '<button class="btn btn-secondary" type="button" data-retry-users>Muat ulang</button>',
      })}</div>`;
      holder.querySelector("[data-retry-users]")?.addEventListener("click", loadUsers);
    }
  }
}

function renderStats() {
  const holder = state.root?.querySelector("#user-stats");
  if (!holder) return;
  const admins = state.users.filter((user) => user.role === "admin" && user.active).length;
  const inactive = state.users.filter((user) => !user.active).length;
  holder.innerHTML = [
    statCard({ label: "Akun terdaftar", value: state.users.length, sub: "Seluruh akun pengguna", iconName: "users" }),
    statCard({ label: "Admin aktif", value: admins, sub: "Dapat mengesahkan opname", iconName: "shield", tone: "blue" }),
    statCard({ label: "Nonaktif", value: inactive, sub: "Akses ditahan sementara", iconName: "lock", tone: "amber" }),
  ].join("");
}

/* ------------------------------------------------------------------ forms */

function openCreateForm() {
  openForm({
    title: "Tambah pengguna",
    eyebrow: "Administrasi · pengguna",
    subtitle: "Berikan password awal yang kuat. Password dapat direset kapan saja tanpa menghapus riwayat.",
    fields: [
      { name: "username", label: "Username", type: "text", required: true, minlength: 3, maxlength: 32, help: "3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung." },
      { name: "full_name", label: "Nama lengkap", type: "text", maxlength: 80 },
      { name: "role", label: "Peran", type: "select", required: true, value: "user", options: [{ value: "user", label: "Pengguna — operasional" }, { value: "admin", label: "Admin — pengawasan & pengesahan" }], full: true },
      { name: "password", label: "Password awal", type: "password", required: true, minlength: 6, autocomplete: "new-password" },
      { name: "confirm_password", label: "Tegaskan password", type: "password", required: true, minlength: 6, autocomplete: "new-password" },
    ],
    submitLabel: "Buat akun",
    submitIcon: "plus",
    onSubmit: async (values) => {
      await api.post("/api/master/users", values);
      toast.success(`Akun @${values.username} dibuat.`);
      await loadUsers();
    },
  });
}

function openEditForm(user) {
  const self = Number(user.id) === Number(me().id) || user.is_self;
  const fields = [
    { name: "username", label: "Username", type: "text", required: true, minlength: 3, maxlength: 32, value: user.username },
    { name: "full_name", label: "Nama lengkap", type: "text", maxlength: 80, value: user.full_name || "" },
  ];
  if (!self) {
    fields.push({ name: "role", label: "Peran", type: "select", required: true, value: user.role, options: [
      { value: "user", label: "Pengguna — operasional" },
      { value: "admin", label: "Admin — pengawasan & pengesahan" },
    ], full: true });
    fields.push({ name: "active", label: "Akun aktif", type: "checkbox", value: Boolean(user.active), full: true, help: "Menonaktifkan akun akan mengakhiri sesi login yang sedang berjalan." });
  }
  openForm({
    title: `Ubah @${user.username}`,
    eyebrow: "Administrasi · pengguna",
    subtitle: self ? "Perubahan nama akan terlihat pada log aktivitas berikutnya." : "Role dan status tercatat pada jejak audit.",
    fields,
    submitLabel: "Simpan perubahan",
    submitIcon: "save",
    onSubmit: async (values) => {
      const payload = { username: values.username, full_name: values.full_name };
      if (!self) {
        payload.role = values.role;
        payload.active = values.active;
      }
      await api.put(`/api/master/users/${user.id}`, payload);
      toast.success("Akun diperbarui.");
      await loadUsers();
    },
  });
}

function openResetForm(user) {
  openForm({
    title: `Reset password @${user.username}`,
    eyebrow: "Administrasi · keamanan",
    subtitle: "Password sementara dapat langsung dipakai login; pengguna boleh menggantinya sendiri kapan saja.",
    intro: `<div class="notice-line">${icon("info", 15)} <span>Semua sesi login aktif milik akun ini akan diakhiri.</span></div>`,
    fields: [
      { name: "new_password", label: "Password sementara", type: "password", required: true, minlength: 6, autocomplete: "new-password" },
      { name: "confirm_password", label: "Tegaskan password", type: "password", required: true, minlength: 6, autocomplete: "new-password" },
    ],
    submitLabel: "Reset password",
    submitIcon: "key",
    onSubmit: async (values) => {
      await api.post(`/api/master/users/${user.id}/reset-password`, values);
      toast.success(`Password @${user.username} direset.`);
      await loadUsers();
    },
  });
}

async function toggleUser(user) {
  const result = await confirmDialog({
    title: `${user.active ? "Nonaktifkan" : "Aktifkan"} akun?`,
    message: user.active
      ? "Akun tidak dapat login dan seluruh sesinya diakhiri. Riwayat aktivitas tetap tersimpan."
      : "Akun akan dapat login kembali dengan password yang berlaku.",
    details: `<strong>@${esc(user.username)}</strong>${user.full_name ? ` · ${esc(user.full_name)}` : ""}`,
    confirmLabel: user.active ? "Nonaktifkan" : "Aktifkan",
    danger: user.active,
    iconName: user.active ? "eyeOff" : "eye",
  });
  if (!result.confirmed) return;
  try {
    await api.put(`/api/master/users/${user.id}`, { active: !user.active });
    toast.success(user.active ? "Akun dinonaktifkan." : "Akun diaktifkan kembali.");
    await loadUsers();
  } catch (error) {
    toast.error(error.message);
  }
}

async function deleteUser(user) {
  const result = await confirmDialog({
    title: `Hapus @${user.username}?`,
    message: "Penghapusan permanen hanya berhasil bila akun belum memiliki riwayat transaksi atau aktivitas. Bila sudah dipakai, nonaktifkan akun agar jejak audit tetap utuh.",
    details: `<strong>@${esc(user.username)}</strong>${user.full_name ? ` · ${esc(user.full_name)}` : ""}<br>Masukkan password akun Anda untuk mengonfirmasi.`,
    confirmLabel: "Hapus pengguna",
    danger: true,
    iconName: "trash",
    requireText: user.username,
    requirePassword: true,
  });
  if (!result.confirmed) return;
  try {
    await api.del(`/api/master/users/${user.id}`, { password: result.password });
    toast.success(`Akun @${user.username} dihapus.`);
    await loadUsers();
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ shell */

export async function render(root) {
  state.root = root;
  state.users = [];
  state.search = "";
  root.innerHTML = `<div class="page-head">
    <div>
      <span class="eyebrow">${icon("shield", 13)} Administrasi akses</span>
      <h1>Pengguna</h1>
      <p>Kelola akun dan peran. Admin dapat mengesahkan opname serta menutup periode; pengguna menangani penerimaan dan pergerakan stok.</p>
    </div>
    <div class="page-actions">
      ${canManage() ? `<button class="btn btn-primary" type="button" data-add-user>${icon("plus", 16)} Tambah pengguna</button>` : ""}
    </div>
  </div>
  <div class="kpi-grid" id="user-stats"></div>
  <div class="filters" style="margin-top:16px">
    <div class="field grow-field"><label class="field-label">Cari akun</label><input class="input" type="search" id="user-search" placeholder="Nama atau username…" autocomplete="off"></div>
    <div class="filter-actions"><span class="field-help" id="user-count"></span></div>
  </div>
  <div class="user-grid" id="user-list"></div>
  <div style="margin-top:14px">${badge("Catatan", "neutral")} <span class="field-help">Akun Admin Utama tersembunyi dari daftar ini dan hanya dapat dikelola oleh pemiliknya.</span></div>`;

  root.querySelector("[data-add-user]")?.addEventListener("click", openCreateForm);
  const search = root.querySelector("#user-search");
  search?.addEventListener("input", () => {
    state.search = search.value;
    renderCards();
  });
  await loadUsers();
  return () => {
    state.seq += 1;
    state.root = null;
  };
}
