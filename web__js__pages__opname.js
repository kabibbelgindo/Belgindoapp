import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  badge, confirmDialog, emptyState, esc, firstOfMonth, fmtDate, fmtM3, fmtQty,
  openForm, statusBadge, toast, todayISO,
} from "../ui.js";
import {
  downloadExport, locations, products, promptReason, refreshAllMeta,
  reasonOptions, specsFor,
} from "./common.js";

const state = {
  home: null,
  session: null,
  permissions: {},
  search: "",
  timers: new Map(),
};

const OTHER_REASON = "Lainnya";

function isDraft(session = state.session) {
  return Boolean(session && session.status === "DRAFT" && !session.closure_id);
}

function isDone(session = state.session) {
  return Boolean(session && session.status === "DONE" && !session.closure_id);
}

function isClosed(session = state.session) {
  return Boolean(session && session.closure_id);
}

/* ------------------------------------------------------------------ beranda */

async function loadHome(root) {
  root.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Menyiapkan stok opname…</span></div>`;
  try {
    state.home = await api.get("/api/opname");
    if (state.home.next?.unclosed) {
      try {
        const detail = await api.get(`/api/opname/${state.home.next.unclosed.id}`);
        state.home.next.unclosed = { ...state.home.next.unclosed, ...detail };
        state.home.sessions = (state.home.sessions || []).map((row) =>
          Number(row.id) === Number(detail.id) ? { ...row, ...detail } : row);
      } catch {
        /* ringkasan sesi tetap ditampilkan tanpa hitungan */
      }
    }
  } catch (error) {
    root.innerHTML = `<div class="card card-pad">${emptyState({ iconName: "alert", title: "Stok opname gagal dimuat", text: error.message })}</div>`;
    return;
  }
  state.permissions = state.home.permissions || {};
  renderHome(root);
}

function renderHome(root) {
  const home = state.home;
  const next = home.next || {};
  const unclosed = next.unclosed;
  const sessions = home.sessions || [];
  const rangeLabel = unclosed
    ? `${unclosed.period_start_display} — ${unclosed.period_end_display}`
    : `${next.start_display || "—"} — ${next.suggested_cutoff_display || "—"}`;
  root.innerHTML = `
    <section class="opname-hero">
      <div>
        <span class="eyebrow">${icon("sparkles", 13)} Pengawasan persediaan</span>
        <h1>Hitung ulang, <em>tenangkan buku.</em></h1>
        <p>Stok opname berjalan berurutan: hitung fisik per periode, sahkan penyesuaian, lalu tutup periode agar tanggal sebelumnya terkunci.</p>
        <div class="hero-actions">
          ${unclosed
            ? `<a class="btn btn-primary" href="#/opname/${unclosed.id}">${icon("play", 16)} Lanjutkan sesi</a>`
            : `<button class="btn btn-primary" type="button" data-start-opname>${icon("plus", 16)} Mulai periode baru</button>`}
          <a class="btn btn-secondary" href="#/reports?tab=transactions">${icon("chart", 16)} Laporan</a>
          <a class="btn btn-ghost" href="#/stock">${icon("package", 16)} Cek stok</a>
        </div>
      </div>
      <div class="opname-hero-side">
        ${unclosed ? badge(unclosed.label_status || "Penghitungan", "amber") : badge("Siap periode baru", "green")}
        <div class="opname-period-range">${esc(rangeLabel)}</div>
        <div class="opname-period-label">${unclosed ? "Periode berjalan" : "Rentang yang disarankan"}</div>
      </div>
    </section>
    <div class="opname-home-grid">
      <div class="stack">
        ${unclosed ? currentSessionCard(unclosed) : readyCard(next)}
        <div class="card">
          <div class="card-header with-line" style="display:flex;justify-content:space-between;align-items:center">
            <div><h2 style="font-size:14px;font-weight:650">Riwayat periode</h2><p style="color:var(--muted);font-size:10.5px;margin-top:2px">${esc(fmtQty(sessions.length))} periode tercatat</p></div>
            <button class="btn btn-ghost btn-sm" type="button" data-export-list>${icon("download", 14)} Ekspor daftar</button>
          </div>
          <div style="padding:0 17px 8px" id="opname-history">${historyRows(sessions)}</div>
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-pad">
          <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Alur yang dijaga</h2></div></div>
          <ol class="hint-list">
            <li>Setiap periode dimulai tepat sehari setelah penutupan terakhir.</li>
            <li>Hitung fisik semua baris, isi alasan setiap selisih.</li>
            <li>Pengesahan memposting penyesuaian bernomor <span class="code-chip">OPN</span>.</li>
            <li>Penutupan mengunci transaksi sampai tanggal cut-off.</li>
            <li>Hanya admin utama yang dapat membuka pengesahan terakhir.</li>
          </ol>
        </div></div>
        <div class="card"><div class="card-pad">
          <div class="section-head" style="margin-bottom:10px"><div><h2 style="font-size:13px">Status kunci</h2></div></div>
          ${home.locked_through
            ? `<div class="status-line"><span>${icon("lock", 16)} Terkunci sampai</span><strong>${esc(fmtDate(home.locked_through))}</strong></div>
               <p class="field-help" style="margin-top:8px">Transaksi bertanggal pada periode tertutup tidak dapat diubah.</p>`
            : `<div class="status-line"><span>${icon("lock", 16)} Periode</span><strong>Belum ada penutupan</strong></div>
               <p class="field-help" style="margin-top:8px">Seluruh tanggal masih terbuka sampai periode pertama ditutup.</p>`}
          ${unclosed ? `<div class="section-divider" style="margin:13px 0"></div><div class="status-line"><span>Periode berikutnya</span><strong>${esc(next.suggested_cutoff_display || "—")}</strong></div>` : ""}
        </div></div>
      </div>
    </div>`;
  root.querySelector("[data-start-opname]")?.addEventListener("click", openCreate);
  root.querySelector("[data-export-list]")?.addEventListener("click", (event) => {
    downloadExport("opname", {}, "daftar-opname.xlsx", event.currentTarget).catch(() => {});
  });
  root.querySelectorAll("[data-open-opname]").forEach((row) => {
    row.addEventListener("click", () => {
      location.hash = `#/opname/${row.dataset.openOpname}`;
    });
  });
}

function currentSessionCard(session) {
  const summary = session.summary || {};
  const progress = summary.items ? Math.round((summary.counted / summary.items) * 100) : 0;
  return `<div class="card opname-current-card"><div class="card-pad">
    <div class="section-head" style="margin-bottom:2px">
      <div><span class="eyebrow">Sesi terbuka</span><h2 style="font-size:18px;margin-top:4px">${esc(session.period_start_display)} — ${esc(session.period_end_display)}</h2>
        <p>Cut-off ${esc(fmtDate(session.period_end))} · dibuat oleh ${esc(session.created_by_name || "—")}</p></div>
      ${statusBadge(session.label_status)}
    </div>
    <div class="opname-progress">
      <div class="opname-progress-cell"><span>Item</span><strong>${esc(fmtQty(summary.items))}</strong></div>
      <div class="opname-progress-cell"><span>Sudah dihitung</span><strong>${esc(fmtQty(summary.counted))}</strong></div>
      <div class="opname-progress-cell"><span>Selisih</span><strong>${esc(fmtQty(summary.variance_items))}</strong></div>
    </div>
    <div class="summary-progress">
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
      <div class="progress-meta"><span>${esc(fmtQty(summary.counted))} dari ${esc(fmtQty(summary.items))} item</span><span>${progress}%</span></div>
    </div>
    <div class="hero-actions">
      <a class="btn btn-primary" href="#/opname/${session.id}">${icon(session.status === "DONE" ? "eye" : "clipboard", 15)} ${session.status === "DONE" ? "Lihat hasil" : "Lanjutkan hitung"}</a>
      <button class="btn btn-secondary" type="button" data-pdf-count="${session.id}">${icon("printer", 15)} Lembar hitung</button>
    </div>
  </div></div>`;
}

function readyCard(next) {
  return `<div class="card"><div class="card-pad">
    <div class="section-head" style="margin-bottom:2px">
      <div><span class="eyebrow">Siap memulai</span><h2 style="font-size:17px;margin-top:4px">Belum ada periode opname terbuka</h2>
        <p>Mulai periode ${esc(next.start_display || "—")} sampai ${esc(next.suggested_cutoff_display || "—")}.</p></div>
      ${badge("Siap", "green")}
    </div>
    <div class="opname-progress">
      <div class="opname-progress-cell"><span>Mulai</span><strong>${esc(next.start_display || "—")}</strong></div>
      <div class="opname-progress-cell"><span>Cut-off usulan</span><strong>${esc(next.suggested_cutoff_display || "—")}</strong></div>
      <div class="opname-progress-cell"><span>Penutupan terakhir</span><strong>${esc(next.last_closed_display || "—")}</strong></div>
    </div>
    <div class="hero-actions">
      <button class="btn btn-primary" type="button" data-start-opname>${icon("plus", 15)} Mulai stok opname</button>
      ${next.last_closed ? `<a class="btn btn-secondary" href="#/opname?closed=1">${icon("history", 15)} Lihat riwayat</a>` : ""}
    </div>
  </div></div>`;
}

function historyRows(sessions) {
  if (!sessions.length) {
    return `<div class="empty-state" style="padding:30px 14px"><span class="empty-icon">${icon("clipboard", 24)}</span><strong>Belum ada periode opname</strong><p>Periode pertama akan memakai stok sistem pada tanggal cut-off sebagai pembanding.</p></div>`;
  }
  return sessions.map((session) => `<div class="opname-history-row" data-open-opname="${session.id}" style="cursor:pointer">
    <span class="opname-history-icon">${icon(session.label_status === "DITUTUP" ? "lock" : session.label_status === "DISAHKAN" ? "checkCircle" : "clipboard", 16)}</span>
    <div class="opname-history-copy">
      <strong>${esc(session.period_start_display)} — ${esc(session.period_end_display)}</strong>
      <span>${esc(fmtQty(session.item_count))} item · dibuat ${esc(session.created_display || "—")}${session.approved_by_name ? ` · disahkan ${esc(session.approved_by_name)}` : ""}</span>
    </div>
    <div class="opname-history-meta">${statusBadge(session.label_status)}<div style="margin-top:4px">${session.closed_display ? `ditutup ${esc(session.closed_display)}` : ""}</div></div>
  </div>`).join("");
}

function openCreate() {
  const next = state.home?.next || {};
  openForm({
    title: "Mulai periode stok opname",
    eyebrow: "Periode baru",
    subtitle: "Stok sistem pada tanggal cut-off akan diambil sebagai pembanding awal.",
    intro: `<div class="notice-line">${icon("info", 15)} <span>Periode dimulai ${esc(next.start_display || "—")}${next.first ? " (periode pertama mengikuti transaksi paling awal)" : " — sehari setelah penutupan terakhir"}.</span></div>`,
    fields: [
      { name: "start", label: "Tanggal mulai", type: "date", required: true, value: next.start || firstOfMonth(), readonly: Boolean(next.last_closed), help: next.last_closed ? "Mengikuti penutupan terakhir agar periode bersambung." : "Tanggal transaksi paling awal." },
      { name: "end", label: "Tanggal cut-off", type: "date", required: true, value: next.suggested_cutoff || todayISO(), max: todayISO(), help: "Tidak boleh melewati hari ini." },
    ],
    submitLabel: "Buat periode",
    submitIcon: "clipboard",
    onSubmit: async (values) => {
      const session = await api.post("/api/opname", { start: values.start, end: values.end });
      toast.success("Periode opname dibuat.");
      refreshAllMeta().catch(() => {});
      location.hash = `#/opname/${session.id}`;
    },
  });
}

/* ------------------------------------------------------------------ detail */

async function loadDetail(root, opnameId) {
  root.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat sesi opname…</span></div>`;
  try {
    state.session = await api.get(`/api/opname/${opnameId}`);
  } catch (error) {
    root.innerHTML = `<div class="page-head"><div><h1>Stok opname</h1><p>Sesi tidak dapat dibuka.</p></div><div class="page-actions"><a class="btn btn-secondary" href="#/opname">${icon("arrowLeft", 15)} Kembali</a></div></div>
      <div class="card card-pad">${emptyState({ iconName: "alert", title: "Sesi opname gagal dimuat", text: error.message, action: '<a class="btn btn-secondary" href="#/opname">Kembali ke beranda</a>' })}</div>`;
    return;
  }
  state.permissions = state.session.permissions || state.permissions;
  state.search = "";
  renderDetail(root);
}

function itemDiff(item) {
  if (item.physical_qty === null || item.physical_qty === undefined || item.physical_qty === "") return null;
  return Number(item.physical_qty) - Number(item.system_qty || 0);
}

function sizeM3(size, qty) {
  const parts = String(size || "").split("x").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part <= 0)) return 0;
  return (parts[0] * parts[1] * parts[2] * Math.abs(Number(qty) || 0)) / 10000000;
}

function computeSummary(items) {
  const summary = { items: items.length, counted: 0, uncounted: 0, variance_items: 0, plus_qty: 0, minus_qty: 0, plus_m3: 0, minus_m3: 0, missing_reason: 0, missing_note: 0 };
  for (const item of items) {
    if (item.physical_qty === null || item.physical_qty === undefined || item.physical_qty === "") {
      summary.uncounted += 1;
      continue;
    }
    summary.counted += 1;
    const diff = itemDiff(item);
    if (Math.abs(diff) < 1e-6) continue;
    summary.variance_items += 1;
    const volume = sizeM3(item.trx_size, diff);
    if (diff > 0) {
      summary.plus_qty += diff;
      summary.plus_m3 += volume;
    } else {
      summary.minus_qty += -diff;
      summary.minus_m3 += volume;
    }
    if (!String(item.reason || "").trim()) summary.missing_reason += 1;
    else if (item.reason === OTHER_REASON && !String(item.note || "").trim()) summary.missing_note += 1;
  }
  return summary;
}

function summaryProblems(summary) {
  const problems = [];
  if (summary.uncounted) problems.push(`${fmtQty(summary.uncounted)} item belum dihitung. Hitung semua item, atau konfirmasi "anggap sesuai stok sistem".`);
  if (summary.missing_reason) problems.push(`${fmtQty(summary.missing_reason)} item selisih belum diberi alasan.`);
  if (summary.missing_note) problems.push(`${fmtQty(summary.missing_note)} item beralasan "Lainnya" wajib diberi catatan.`);
  return problems;
}

function renderDetail(root) {
  const session = state.session;
  const items = session.items || [];
  const summary = session.summary || computeSummary(items);
  const progress = summary.items ? Math.round((summary.counted / summary.items) * 100) : 0;
  const draft = isDraft();
  const done = isDone();
  const closed = isClosed();
  root.innerHTML = `
    <div class="page-head">
      <div>
        <span class="eyebrow">${icon("clipboard", 13)} Stok opname #${session.id}</span>
        <h1>${esc(session.period_start_display)} — ${esc(session.period_end_display)}</h1>
        <p>${closed ? "Periode telah ditutup dan tanggal sampai cut-off terkunci." : done ? "Hitungan telah disahkan. Saldo buku sudah disesuaikan." : "Isi stok fisik setiap baris. Perubahan tersimpan otomatis."}</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-ghost" href="#/opname">${icon("arrowLeft", 15)} Beranda</a>
        <button class="btn btn-secondary" type="button" data-pdf="${closed ? "result" : done ? "result" : "count"}">${icon("printer", 15)} PDF</button>
        <button class="btn btn-secondary" type="button" data-export>${icon("download", 15)} Excel</button>
      </div>
    </div>
    <div class="status-strip">
      ${statusBadge(session.label_status)}
      <span class="badge badge-neutral">${icon("calendar", 12)} Cut-off ${esc(fmtDate(session.period_end))}</span>
      ${closed ? `<span class="badge badge-neutral">${icon("lock", 12)} Ditutup ${esc(session.closed_at ? fmtDate(session.closed_at) : "")}</span>` : ""}
      <span class="report-period" style="margin-left:auto"><span>Kemajuan</span><strong>${esc(fmtQty(summary.counted))} / ${esc(fmtQty(summary.items))} item · ${progress}%</strong></span>
    </div>
    <div class="count-layout">
      <div class="count-main">
        <div class="card card-flush">
          <div class="card-header with-line" style="padding-bottom:12px">
            <div class="count-toolbar" style="margin-bottom:0">
              <div class="search-inline">${icon("search", 15)}<input class="input" id="opname-search" type="search" value="${esc(state.search)}" placeholder="Cari barang, kode, ukuran, lokasi…" aria-label="Cari item opname"></div>
              ${draft ? `<button class="btn btn-secondary btn-sm" type="button" data-add-found>${icon("plus", 15)} Barang temuan</button>` : ""}
              ${draft ? `<button class="btn btn-ghost btn-sm" type="button" data-refresh-items>${icon("refresh", 14)} Muat ulang</button>` : ""}
              <span class="row-save-state" id="opname-save-info"></span>
            </div>
          </div>
          <div id="count-table-wrap">
            ${items.length ? `<div class="table-wrap"><table class="table count-table"><thead><tr>
              <th>Barang</th><th>Lokasi</th><th class="num">Stok sistem</th><th>Stok fisik</th><th class="num">Selisih</th><th>Alasan</th><th>Catatan</th>
            </tr></thead><tbody id="count-body">${items.map((item) => rowHTML(item, draft)).join("")}</tbody></table></div>` : `<div class="empty-state" style="padding:40px"><span class="empty-icon">${icon("clipboard", 26)}</span><strong>Tidak ada item</strong><p>Gunakan "Muat ulang" untuk mengambil snapshot stok pada cut-off.</p></div>`}
          </div>
        </div>
      </div>
      <aside class="count-aside">
        <div class="card opname-summary-card" id="opname-summary">${summaryHTML(summary)}</div>
        <div class="card"><div class="card-pad">
          <div class="opname-summary-title"><strong>Informasi sesi</strong>${session.closure_id ? badge("Ditutup", "neutral") : badge(session.status === "DONE" ? "Disahkan" : "Draf", session.status === "DONE" ? "blue" : "amber")}</div>
          <div class="meta-grid">
            <div class="meta-cell"><span>Dibuat</span><strong>${esc(session.created_at ? String(session.created_at).slice(0, 16).replace("T", " ") : "—")}</strong></div>
            <div class="meta-cell"><span>Oleh</span><strong>${esc(session.created_by_name || "—")}</strong></div>
            <div class="meta-cell"><span>Disahkan</span><strong>${esc(session.approved_by_name || "—")}</strong></div>
            <div class="meta-cell"><span>Cut-off</span><strong>${esc(fmtDate(session.period_end))}</strong></div>
          </div>
        </div></div>
      </aside>
    </div>`;
  bindDetail(root);

  if (!items.length) return;

  const body = root.querySelector("#count-body");
  root.querySelector("#opname-search")?.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    body.querySelectorAll("tr[data-item]").forEach((row) => {
      row.hidden = Boolean(state.search) && !row.textContent.toLowerCase().includes(state.search);
    });
  });

  if (draft) {
    body.querySelectorAll("tr[data-item]").forEach((row) => {
      const item = items.find((entry) => Number(entry.id) === Number(row.dataset.item));
      if (!item) return;
      const qtyInput = row.querySelector("[data-count]");
      const reasonSelect = row.querySelector("[data-reason]");
      const noteInput = row.querySelector("[data-note]");
      const schedule = () => {
        const key = Number(item.id);
        window.clearTimeout(state.timers.get(key));
        state.timers.set(key, window.setTimeout(() => saveItem(item.id, true), 650));
      };
      qtyInput?.addEventListener("input", () => {
        item.physical_qty = qtyInput.value === "" ? null : Number(qtyInput.value);
        paintRow(row, item);
        paintSummary();
        schedule();
      });
      qtyInput?.addEventListener("change", () => {
        window.clearTimeout(state.timers.get(Number(item.id)));
        saveItem(item.id);
      });
      reasonSelect?.addEventListener("change", () => {
        item.reason = reasonSelect.value;
        paintSummary();
        saveItem(item.id);
      });
      noteInput?.addEventListener("input", () => {
        item.note = noteInput.value;
        paintSummary();
        schedule();
      });
      noteInput?.addEventListener("change", () => {
        window.clearTimeout(state.timers.get(Number(item.id)));
        saveItem(item.id);
      });
    });
  }
}

function rowHTML(item, draft) {
  const diff = itemDiff(item);
  const diffClass = diff === null ? "diff-zero" : Math.abs(diff) < 1e-6 ? "diff-zero" : diff > 0 ? "diff-plus" : "diff-minus";
  const diffText = diff === null ? "—" : `${diff > 0 ? "+" : ""}${fmtQty(diff)}`;
  const diffM3 = diff === null ? "" : `${fmtM3(sizeM3(item.trx_size, diff))} m³`;
  const search = `${item.code} ${item.name} ${item.size_display} ${item.location}`.toLowerCase();
  if (!draft) {
    return `<tr data-item="${item.id}" data-search="${esc(search)}">
      <td class="item-product count-product-col"><strong>${esc(item.name)}</strong><span>${esc(item.code)} · ${esc(item.size_display)}</span></td>
      <td class="count-loc">${esc(item.location || "—")}</td>
      <td class="num">${esc(fmtQty(item.system_qty))}</td>
      <td class="num">${item.counted ? `<strong>${esc(fmtQty(item.physical_qty))}</strong>` : "—"}</td>
      <td class="num"><span class="diff-value ${diffClass}">${esc(diffText)}${diffM3 ? `<span class="diff-m3">${esc(diffM3)}</span>` : ""}</span></td>
      <td>${esc(item.reason || "—")}</td>
      <td>${esc(item.note || "—")}</td>
    </tr>`;
  }
  return `<tr data-item="${item.id}" data-search="${esc(search)}">
    <td class="item-product count-product-col"><strong>${esc(item.name)}</strong><span>${esc(item.code)} · ${esc(item.size_display)}</span></td>
    <td class="count-loc">${esc(item.location || "—")}</td>
    <td class="num">${esc(fmtQty(item.system_qty))}</td>
    <td>
      <input class="count-input" type="number" inputmode="decimal" min="0" step="any" data-count value="${item.physical_qty === null || item.physical_qty === undefined ? "" : esc(item.physical_qty)}" placeholder="—" aria-label="Stok fisik ${esc(item.name)}">
      <span class="row-save-state" data-state></span>
    </td>
    <td class="num"><span class="diff-value ${diffClass}" data-diff>${esc(diffText)}${diffM3 ? `<span class="diff-m3">${esc(diffM3)}</span>` : ""}</span></td>
    <td><select class="input reason-select" data-reason aria-label="Alasan selisih">
      <option value="">— pilih alasan —</option>
      ${reasonOptions().map((option) => `<option value="${esc(option.value)}" ${item.reason === option.value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}
    </select></td>
    <td><input class="input note-inline" type="text" maxlength="300" data-note value="${esc(item.note || "")}" placeholder="Catatan…" aria-label="Catatan ${esc(item.name)}"></td>
  </tr>`;
}

function paintRow(row, item) {
  const diff = itemDiff(item);
  const cell = row.querySelector("[data-diff]");
  if (!cell) return;
  const cls = diff === null ? "diff-zero" : Math.abs(diff) < 1e-6 ? "diff-zero" : diff > 0 ? "diff-plus" : "diff-minus";
  cell.className = `diff-value ${cls}`;
  const m3 = diff === null ? 0 : sizeM3(item.trx_size, diff);
  cell.innerHTML = diff === null ? "—" : `${diff > 0 ? "+" : ""}${esc(fmtQty(diff))}${m3 ? `<span class="diff-m3">${esc(fmtM3(m3))} m³</span>` : ""}`;
}

function paintSummary() {
  const holder = document.getElementById("opname-summary");
  if (!holder) return;
  const summary = computeSummary(state.session.items || []);
  state.session.summary = summary;
  holder.innerHTML = summaryHTML(summary);
  const progress = summary.items ? Math.round((summary.counted / summary.items) * 100) : 0;
  const period = document.querySelector(".report-period strong");
  if (period) period.textContent = `${fmtQty(summary.counted)} / ${fmtQty(summary.items)} item · ${progress}%`;
  bindSummaryActions(holder);
}

function summaryHTML(summary) {
  const problems = summaryProblems(summary);
  const draft = isDraft();
  const perms = state.permissions || {};
  const done = isDone();
  const closed = isClosed();
  const progress = summary.items ? Math.round((summary.counted / summary.items) * 100) : 0;
  return `${closed ? `<div class="opname-summary-title"><strong>Periode ditutup</strong>${badge("Selesai", "neutral")}</div>
    <div class="summary-big">${esc(fmtQty(summary.variance_items))} <small>baris berselisih</small></div>
    <div class="summary-stats">
      <div class="summary-stat plus"><span>Lebih</span><strong>${esc(fmtQty(summary.plus_qty))} · ${esc(fmtM3(summary.plus_m3))} m³</strong></div>
      <div class="summary-stat minus"><span>Kurang</span><strong>${esc(fmtQty(summary.minus_qty))} · ${esc(fmtM3(summary.minus_m3))} m³</strong></div>
      <div class="summary-stat"><span>Item</span><strong>${esc(fmtQty(summary.items))}</strong></div>
      <div class="summary-stat"><span>Sudah dihitung</span><strong>${esc(fmtQty(summary.counted))}</strong></div>
    </div>
    <div class="opname-summary-actions">
      <button class="btn btn-secondary btn-block" type="button" data-pdf-result>${icon("printer", 15)} Cetak hasil</button>
    </div>
    ${state.session?.closure?.rows ? `<div class="field-help" style="margin-top:10px">${esc(fmtQty(state.session.closure.rows.length))} baris saldo terekam dalam penutupan.</div>` : ""}`
  : `<div class="opname-summary-title"><strong>${done ? "Hasil pengesahan" : "Ringkasan hitungan"}</strong>${done ? badge("Disahkan", "blue") : badge("Berjalan", "amber")}</div>
    <div class="summary-big">${esc(fmtQty(summary.variance_items))} <small>baris berselisih</small></div>
    <div class="summary-stats">
      <div class="summary-stat plus"><span>Selisih lebih</span><strong>${esc(fmtQty(summary.plus_qty))}</strong></div>
      <div class="summary-stat minus"><span>Selisih kurang</span><strong>${esc(fmtQty(summary.minus_qty))}</strong></div>
      <div class="summary-stat"><span>Volume lebih</span><strong>${esc(fmtM3(summary.plus_m3))} m³</strong></div>
      <div class="summary-stat"><span>Volume kurang</span><strong>${esc(fmtM3(summary.minus_m3))} m³</strong></div>
    </div>
    <div class="summary-progress">
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
      <div class="progress-meta"><span>${esc(fmtQty(summary.counted))} dari ${esc(fmtQty(summary.items))} dihitung</span><span>${progress}%</span></div>
    </div>
    ${problems.length ? `<div class="opname-problems" style="margin-top:12px">${problems.map((text) => `<div class="opname-problem">${icon("alert", 14)}<span>${esc(text)}</span></div>`).join("")}</div>` : `<div class="notice-line" style="margin-top:12px">${icon("checkCircle", 14)} Semua baris siap disahkan.</div>`}
    <div class="opname-summary-actions">
      ${done ? `
        ${perms.close_period ? `<button class="btn btn-primary btn-block" type="button" data-close>${icon("lock", 15)} Tutup periode</button>` : ""}
        <button class="btn btn-secondary btn-block" type="button" data-pdf-result>${icon("printer", 15)} Cetak hasil</button>
        ${perms.reopen_opname ? `<button class="btn btn-ghost btn-block" type="button" data-reopen>${icon("rotate", 15)} Buka kembali</button>` : ""}
      ` : `
        ${perms.approve_opname ? `<button class="btn btn-primary btn-block" type="button" data-approve ${problems.length ? `disabled title="Lengkapi ${problems.length} masalah terlebih dahulu"` : ""}>${icon("checkCircle", 15)} Sahkan opname</button>` : ""}
        ${perms.approve_opname ? `<button class="btn btn-secondary btn-block" type="button" data-fill>${icon("sparkles", 15)} Isi sesuai sistem</button>` : ""}
        <button class="btn btn-ghost btn-block" type="button" data-pdf-count>${icon("printer", 15)} Lembar hitung</button>
        ${perms.cancel_opname ? `<button class="btn btn-ghost btn-block" type="button" data-cancel-draft>${icon("trash", 15)} Batalkan draf</button>` : ""}
      `}
    </div>`}`;
}

function bindSummaryActions(holder) {
  holder.querySelector("[data-approve]")?.addEventListener("click", approveSession);
  holder.querySelector("[data-fill]")?.addEventListener("click", fillUncounted);
  holder.querySelector("[data-close]")?.addEventListener("click", closePeriod);
  holder.querySelector("[data-reopen]")?.addEventListener("click", reopenSession);
  holder.querySelector("[data-cancel-draft]")?.addEventListener("click", cancelDraft);
  holder.querySelector("[data-pdf-result]")?.addEventListener("click", () => api.openPdf(`/api/pdf/opname/${state.session.id}`, { mode: "result" }));
  holder.querySelector("[data-pdf-count]")?.addEventListener("click", () => api.openPdf(`/api/pdf/opname/${state.session.id}`, { mode: "count" }));
}

function bindDetail(root) {
  bindSummaryActions(document.getElementById("opname-summary") || root);
  root.querySelector("[data-pdf]")?.addEventListener("click", () => {
    api.openPdf(`/api/pdf/opname/${state.session.id}`, { mode: isDraft() ? "count" : "result" });
  });
  root.querySelector("[data-export]")?.addEventListener("click", (event) => {
    downloadExport("opname", { id: state.session.id }, `opname-${state.session.id}.xlsx`, event.currentTarget).catch(() => {});
  });
  root.querySelector("[data-add-found]")?.addEventListener("click", addFoundItem);
  root.querySelector("[data-refresh-items]")?.addEventListener("click", refreshItems);
}

async function saveItem(itemId, quiet = false) {
  const item = (state.session.items || []).find((entry) => Number(entry.id) === Number(itemId));
  if (!item) return;
  const row = document.querySelector(`tr[data-item="${itemId}"]`);
  const stateEl = row?.querySelector("[data-state]");
  const qtyInput = row?.querySelector("[data-count]");
  qtyInput?.classList.remove("is-saving", "is-saved", "is-error");
  qtyInput?.classList.add("is-saving");
  if (stateEl) stateEl.textContent = "menyimpan…";
  try {
    await api.put(`/api/opname/${state.session.id}/items/${itemId}`, {
      physical_qty: item.physical_qty === null || item.physical_qty === undefined || item.physical_qty === "" ? null : item.physical_qty,
      reason: item.reason || "",
      note: item.note || "",
    });
    qtyInput?.classList.remove("is-saving");
    qtyInput?.classList.add("is-saved");
    if (stateEl) {
      stateEl.textContent = "tersimpan";
      stateEl.classList.add("saved");
      stateEl.classList.remove("error");
    }
    window.setTimeout(() => {
      qtyInput?.classList.remove("is-saved");
      if (stateEl && stateEl.textContent === "tersimpan") {
        stateEl.textContent = "";
        stateEl.classList.remove("saved");
      }
    }, 1600);
  } catch (error) {
    qtyInput?.classList.remove("is-saving");
    qtyInput?.classList.add("is-error");
    if (stateEl) {
      stateEl.textContent = "gagal";
      stateEl.classList.add("error");
      stateEl.classList.remove("saved");
    }
    if (!quiet) toast.error(error.message);
  }
}

async function addFoundItem() {
  const productOptions = products().map((row) => ({ value: row.value, label: row.label }));
  const reasonChoices = reasonOptions();
  openForm({
    title: "Tambah barang temuan",
    eyebrow: "Stok opname",
    subtitle: "Catat barang yang ditemukan di gudang namun belum ada pada snapshot.",
    fields: [
      { name: "product_id", label: "Barang", type: "select", options: productOptions, required: true, full: true },
      { name: "thickness", label: "Tebal (T, mm)", type: "select", options: specsFor("T"), required: true },
      { name: "width", label: "Lebar (L, cm)", type: "select", options: specsFor("L"), required: true },
      { name: "length", label: "Panjang (P, cm)", type: "select", options: specsFor("P"), required: true },
      { name: "location", label: "Lokasi", type: "select", options: locations({ includeEmpty: true }), required: false },
      { name: "physical_qty", label: "Stok fisik", type: "number", required: true, min: 0, step: "any", value: "" },
      { name: "reason", label: "Alasan", type: "select", options: reasonChoices, required: true, value: "Barang temuan" },
      { name: "note", label: "Catatan", type: "textarea", rows: 3, full: true, maxlength: 300, placeholder: "Keterangan barang temuan" },
    ],
    submitLabel: "Tambah ke opname",
    submitIcon: "plus",
    onSubmit: async (values) => {
      await api.post(`/api/opname/${state.session.id}/items`, {
        product_id: values.product_id,
        size: `${values.length}x${values.thickness}x${values.width}`,
        location: values.location || "",
        physical_qty: values.physical_qty,
        reason: values.reason || "Barang temuan",
        note: values.note || "",
      });
      toast.success("Barang temuan ditambahkan.");
      await refreshDetail();
    },
  });
}

async function refreshDetail() {
  const id = state.session.id;
  state.session = await api.get(`/api/opname/${id}`);
  state.permissions = state.session.permissions || state.permissions;
  const root = document.getElementById("view");
  if (root) renderDetail(root);
}

async function flushSaves() {
  const pending = [...state.timers.entries()];
  for (const [itemId, timer] of pending) {
    window.clearTimeout(timer);
    state.timers.delete(itemId);
  }
  if (pending.length) {
    await Promise.all(pending.map(([itemId]) => saveItem(itemId, true)));
  }
}

async function refreshItems() {
  await flushSaves();
  const result = await confirmDialog({
    title: "Muat ulang snapshot?",
    message: "Stok sistem akan disegarkan dari transaksi terkini pada tanggal cut-off. Hitungan fisik yang sudah diisi tetap tersimpan.",
    confirmLabel: "Muat ulang",
    iconName: "refresh",
  });
  if (!result.confirmed) return;
  try {
    const response = await api.post(`/api/opname/${state.session.id}/refresh`, {});
    toast.success(`Snapshot diperbarui: ${response.added} ditambah, ${response.updated} diubah, ${response.removed} dihapus.`);
    await refreshDetail();
  } catch (error) {
    toast.error(error.message);
  }
}

async function fillUncounted() {
  await flushSaves();
  const result = await confirmDialog({
    title: "Isi sesuai stok sistem?",
    message: "Semua item yang belum dihitung akan diisi sebesar stok sistem dan dianggap sesuai. Anda masih dapat mengubahnya sebelum pengesahan.",
    confirmLabel: "Isi otomatis",
    iconName: "sparkles",
  });
  if (!result.confirmed) return;
  try {
    const response = await api.post(`/api/opname/${state.session.id}/fill`, {});
    toast.success(`${response.filled} item diisi sesuai stok sistem.`);
    await refreshDetail();
  } catch (error) {
    toast.error(error.message);
  }
}

async function approveSession() {
  await flushSaves();
  const summary = computeSummary(state.session.items || []);
  const problems = summaryProblems(summary);
  if (problems.length) {
    toast.warn("Lengkapi hitungan, alasan, dan catatan sebelum mengesahkan opname.");
    refreshDetail();
    return;
  }
  const result = await confirmDialog({
    title: "Sahkan stok opname?",
    message: "Penyesuaian akan diposting ke buku stok dengan nomor OPN. Setelah disahkan, hitungan tidak dapat diubah kecuali dibuka kembali oleh admin utama.",
    details: `<div class="summary-stats" style="margin-top:4px">
      <div class="summary-stat plus"><span>Lebih</span><strong>${esc(fmtQty(summary.plus_qty))} batang</strong></div>
      <div class="summary-stat minus"><span>Kurang</span><strong>${esc(fmtQty(summary.minus_qty))} batang</strong></div>
      <div class="summary-stat"><span>Selisih</span><strong>${esc(fmtQty(summary.variance_items))} baris</strong></div>
      <div class="summary-stat"><span>Belum dihitung</span><strong>${esc(fmtQty(summary.uncounted))}</strong></div>
    </div>${problems.length ? `<div class="opname-problems" style="margin-top:8px">${problems.map((text) => `<div class="opname-problem">${icon("alert", 14)}<span>${esc(text)}</span></div>`).join("")}</div>` : ""}`,
    confirmLabel: "Sahkan & posting",
    iconName: "checkCircle",
  });
  if (!result.confirmed) return;
  try {
    const response = await api.post(`/api/opname/${state.session.id}/approve`, {});
    toast.success(`Opname disahkan. ${response.adjustments} penyesuaian diposting.`);
    refreshAllMeta().catch(() => {});
    await refreshDetail();
  } catch (error) {
    toast.error(error.message);
  }
}

async function closePeriod() {
  const result = await confirmDialog({
    title: "Tutup periode opname?",
    message: "Seluruh transaksi sampai tanggal cut-off akan terkunci. Tindakan ini mengunci periode dan hanya dapat dibuka kembali lewat pengesahan jika memungkinkan.",
    confirmLabel: "Tutup periode",
    iconName: "lock",
    danger: true,
  });
  if (!result.confirmed) return;
  try {
    const response = await api.post(`/api/opname/${state.session.id}/close`, {});
    toast.success(`Periode ditutup. ${response.items} baris saldo direkam.`);
    refreshAllMeta().catch(() => {});
    await refreshDetail();
  } catch (error) {
    toast.error(error.message);
  }
}

async function reopenSession() {
  const values = await promptReason({
    title: "Buka kembali pengesahan?",
    message: "Penyesuaian OPN akan dihapus dan periode kembali menjadi draf. Hanya periode terakhir yang dapat dibuka.",
    eyebrow: "Koreksi pengesahan",
    confirmLabel: "Buka kembali",
    label: "Alasan membuka kembali (min. 5 karakter)",
    placeholder: "Contoh: hitungan fisik perlu dikoreksi",
    iconName: "rotate",
  });
  if (!values) return;
  if (String(values.reason || "").trim().length < 5) {
    toast.warn("Alasan minimal 5 karakter.");
    return;
  }
  try {
    const response = await api.post(`/api/opname/${state.session.id}/reopen`, { reason: values.reason });
    toast.success(`Pengesahan dibuka. ${response.deleted} baris penyesuaian dihapus.`);
    refreshAllMeta().catch(() => {});
    await refreshDetail();
  } catch (error) {
    toast.error(error.message);
  }
}

async function cancelDraft() {
  const values = await promptReason({
    title: "Batalkan draf opname?",
    message: "Seluruh item dan sesi draf akan dihapus. Tindakan ini tidak memengaruhi stok.",
    eyebrow: "Batalkan sesi",
    confirmLabel: "Hapus draf",
  });
  if (!values) return;
  try {
    await api.post(`/api/opname/${state.session.id}/cancel`, {});
    toast.success("Draf opname dibatalkan.");
    location.hash = "#/opname";
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ entry */

export async function render(root, { route } = {}) {
  for (const timer of state.timers.values()) window.clearTimeout(timer);
  state.timers.clear();
  state.session = null;
  state.home = null;
  const cleanup = () => {
    for (const timer of state.timers.values()) window.clearTimeout(timer);
    state.timers.clear();
  };
  const opnameId = route?.segment?.[1];
  if (opnameId && /^\d+$/.test(opnameId)) {
    await loadDetail(root, opnameId);
    return cleanup;
  }
  await loadHome(root);
  if (route?.query?.get("new") === "1" && state.home && !state.home.next?.unclosed) {
    openCreate();
  }
  return cleanup;
}
