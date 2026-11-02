import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  emptyState, esc, firstOfMonth, fmtQty, statCard, toast, todayISO,
} from "../ui.js";
import {
  dateInput, downloadExport, readForm, searchInput, selectField,
} from "./common.js";

const state = {
  root: null,
  users: [],
  rows: [],
  filters: {
    start: firstOfMonth(),
    end: todayISO(),
    user_id: "",
    query: "",
    limit: "500",
  },
  seq: 0,
};

function userOptions() {
  return state.users.map((user) => ({
    value: user.id,
    label: user.full_name ? `${user.full_name} (@${user.username})` : `@${user.username}`,
  }));
}

function filtersHTML() {
  const f = state.filters;
  return `<form class="filters" id="activity-filters">
    ${dateInput("start", f.start, { label: "Dari tanggal" })}
    ${dateInput("end", f.end, { label: "Sampai tanggal" })}
    ${selectField("user_id", "Pengguna", userOptions(), f.user_id, { placeholder: "Semua pengguna" })}
    ${searchInput("query", f.query, { label: "Cari", placeholder: "Aksi, rincian, username…" })}
    ${selectField("limit", "Batas baris", [
      { value: "100", label: "100 baris" },
      { value: "500", label: "500 baris" },
      { value: "1000", label: "1.000 baris" },
      { value: "2000", label: "2.000 baris" },
    ], f.limit)}
    <div class="filter-actions">
      <button class="btn btn-secondary btn-sm" type="button" data-activity-export>${icon("download", 14)} Ekspor</button>
      <button class="btn btn-primary btn-sm" type="submit">${icon("filter", 14)} Terapkan</button>
    </div>
  </form>`;
}

function renderFilters() {
  const holder = state.root?.querySelector("#activity-filter-holder");
  if (!holder) return;
  holder.innerHTML = filtersHTML();
  const form = holder.querySelector("#activity-filters");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    Object.assign(state.filters, readForm(form));
    if (state.filters.start > state.filters.end) {
      toast.warn("Tanggal dari tidak boleh melewati tanggal sampai.");
      return;
    }
    loadActivity();
  });
  holder.querySelector("[data-activity-export]")?.addEventListener("click", (event) => {
    const params = {
      start: state.filters.start, end: state.filters.end,
      user_id: state.filters.user_id, query: state.filters.query,
    };
    downloadExport("activity", params, `log-aktivitas-${state.filters.end || todayISO()}.xlsx`, event.currentTarget).catch(() => {});
  });
}

function stats(rows) {
  const users = new Set(rows.map((row) => row.username)).size;
  const actions = new Set(rows.map((row) => row.action)).size;
  return `<div class="kpi-grid" id="activity-stats">
    ${statCard({ label: "Baris log", value: fmtQty(rows.length), sub: "Maksimal sesuai batas baris", iconName: "pulse" })}
    ${statCard({ label: "Pengguna tercatat", value: fmtQty(users), sub: "Akun yang melakukan aksi", iconName: "users", tone: "blue" })}
    ${statCard({ label: "Jenis aksi", value: fmtQty(actions), sub: "Kode aksi unik", iconName: "tag", tone: "amber" })}
    ${statCard({ label: "Rentang", value: `${esc(state.filters.start.slice(0, 10))}`, sub: `s.d. ${esc(state.filters.end.slice(0, 10))}`, iconName: "calendar", tone: "dark" })}
  </div>`;
}

function topActions(rows) {
  const buckets = new Map();
  for (const row of rows) buckets.set(row.action, (buckets.get(row.action) || 0) + 1);
  const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!top.length) return `<p class="field-help">Belum ada aksi pada periode ini.</p>`;
  const max = top[0][1] || 1;
  return `<div class="backup-list">${top.map(([action, count]) => `<div class="backup-row" style="display:block">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
      <span class="action-tag">${esc(action)}</span>
      <strong>${esc(fmtQty(count))}</strong>
    </div>
    <div class="progress-track" style="margin-top:6px;height:4px"><div class="progress-fill" style="width:${Math.round((count / max) * 100)}%"></div></div>
  </div>`).join("")}</div>`;
}

function tableRows(rows) {
  if (!rows.length) {
    return `<tr><td colspan="4" style="padding:0"><div class="empty-state" style="padding:40px 18px">
      <span class="empty-icon">${icon("pulse", 26)}</span><strong>Tidak ada aktivitas</strong>
      <p>Ubah rentang tanggal atau kata kunci untuk melihat jejak audit lain.</p>
    </div></td></tr>`;
  }
  return rows.map((row) => `<tr>
    <td class="cell-sub" style="white-space:nowrap">${esc(row.time_display || "—")}</td>
    <td><span class="user-handle">@${esc(row.username)}</span></td>
    <td><span class="action-tag">${esc(row.action)}</span></td>
    <td style="max-width:640px;word-break:break-word">${esc(row.detail || "—")}</td>
  </tr>`).join("");
}

function renderTable(rows) {
  const holder = state.root?.querySelector("#activity-body");
  if (!holder) return;
  holder.innerHTML = `${stats(rows)}
    <div class="system-grid" style="margin-top:14px">
      <div class="card card-flush">
        <div class="card-header with-line" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding-bottom:12px">
          <div><h2 style="font-size:13px;font-weight:650">Jejak audit</h2><p class="field-help">${esc(fmtQty(rows.length))} baris · terbaru di atas</p></div>
          <span class="badge badge-neutral">${icon("lock", 12)} Hanya baca</span>
        </div>
        <div class="table-wrap scroll-500"><table class="table activity-table">
          <thead><tr><th>Waktu</th><th>Pengguna</th><th>Aksi</th><th>Rincian</th></tr></thead>
          <tbody>${tableRows(rows)}</tbody>
        </table></div>
      </div>
      <aside class="stack">
        <div class="card"><div class="card-pad">
          <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Aksi terbanyak</h2><p>Enam kode aksi yang paling sering muncul.</p></div></div>
          ${topActions(rows)}
        </div></div>
        <div class="card"><div class="card-pad">
          <div class="section-head" style="margin-bottom:8px"><div><h2 style="font-size:13px">Tentang log ini</h2></div></div>
          <p class="field-help">Setiap penerimaan, koreksi, pengesahan, perubahan master, dan tindakan administratif dicatat dengan waktu dan pelakunya. Log tidak dapat diubah dari antarmuka.</p>
          <div class="section-divider"></div>
          <div class="notice-line">${icon("shield", 15)} <span>Ekspor log mengikuti filter tanggal dan pengguna yang aktif.</span></div>
        </div></div>
      </aside>
    </div>`;
}

async function loadActivity() {
  const body = state.root?.querySelector("#activity-body");
  if (!body) return;
  const seq = ++state.seq;
  body.innerHTML = `<div class="card"><div class="loading-block"><span class="spinner"></span><span>Menyusun jejak audit…</span></div></div>`;
  try {
    const data = await api.get("/api/admin/activity", {
      start: state.filters.start,
      end: state.filters.end,
      user_id: state.filters.user_id,
      query: state.filters.query,
      limit: state.filters.limit,
    });
    if (seq !== state.seq) return;
    state.rows = data.rows || [];
    renderTable(state.rows);
  } catch (error) {
    if (seq !== state.seq) return;
    body.innerHTML = `<div class="card card-pad">${emptyState({
      iconName: "alert", title: "Log aktivitas gagal dimuat", text: error.message,
      action: '<button class="btn btn-secondary" type="button" data-retry-activity>Muat ulang</button>',
    })}</div>`;
    body.querySelector("[data-retry-activity]")?.addEventListener("click", loadActivity);
  }
}

export async function render(root) {
  state.root = root;
  state.rows = [];
  state.seq += 1;
  root.innerHTML = `<div class="page-head">
    <div>
      <span class="eyebrow">${icon("pulse", 13)} Pengawasan internal</span>
      <h1>Log Aktivitas</h1>
      <p>Rekam jejak seluruh tindakan penting di PT. Belgindo Raya Inventory — siapa, kapan, dan apa yang berubah. Gunakan filter untuk menelusuri satu kejadian.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary" type="button" data-activity-refresh>${icon("refresh", 16)} Segarkan</button>
    </div>
  </div>
  <div id="activity-filter-holder"></div>
  <div id="activity-body"></div>`;

  try {
    const data = await api.get("/api/master/users");
    state.users = data.users || [];
  } catch {
    state.users = [];
  }
  renderFilters();
  root.querySelector("[data-activity-refresh]")?.addEventListener("click", loadActivity);
  await loadActivity();
  return () => {
    state.seq += 1;
    state.root = null;
  };
}
