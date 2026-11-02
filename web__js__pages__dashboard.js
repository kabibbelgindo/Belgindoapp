import { api } from "../api.js";
import { icon } from "../icons.js";
import { state, isAdmin, isPrimary } from "../state.js";
import {
  esc, fmtDate, fmtDateFull, fmtM3, fmtMoney, fmtMoneyShort, fmtQty, greeting, statCard,
} from "../ui.js";
import { blankCard, pageHead, refreshAllMeta, sectionHead } from "./common.js";

function heroMarkup(data) {
  const user = state.meta?.user || {};
  const name = String(user.full_name || user.username || "").split(" ")[0];
  const month = data.month_in || {};
  return `<section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">${icon("sparkles", 13)} ${esc(fmtDateFull(data.today))}</span>
      <h1>${esc(greeting())}, <em>${esc(name || "rekan gudang")}</em>.<br>Gudang hari ini, dalam satu pandangan.</h1>
      <p>Penerimaan, tally, stok per lot, dan opname bergerak bersama. Mulai dari alur yang paling sering Anda kerjakan.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#/receiving">${icon("inbox", 16)} Terima barang</a>
        <a class="btn btn-secondary" href="#/outgoing">${icon("outgoing", 16)} Barang keluar</a>
        <a class="btn btn-secondary" href="#/opname">${icon("history", 16)} Stok opname</a>
      </div>
    </div>
    <div class="hero-side">
      <div class="hero-mini">
        ${icon("warehouse", 18)}
        <div><span>Barang masuk bulan ini</span><strong>${esc(fmtQty(month.qty))} batang</strong></div>
      </div>
      <div class="hero-mini">
        ${icon("package", 18)}
        <div><span>Nilai persediaan</span><strong>${esc(fmtMoneyShort(data.stock?.value))}</strong></div>
      </div>
      <div class="hero-mini">
        ${icon("users", 18)}
        <div><span>Penjual aktif</span><strong>${esc(fmtQty(data.counts?.sellers))} penjual</strong></div>
      </div>
    </div>
  </section>`;
}

function kpiMarkup(data) {
  const stock = data.stock || {};
  const monthIn = data.month_in || {};
  return `<div class="kpi-grid">
    ${statCard({
      label: "Persediaan saat ini",
      value: fmtQty(stock.qty),
      sub: `<span>${esc(fmtM3(stock.m3))} m³</span><span>·</span><span>${esc(fmtQty(stock.rows))} kelompok ukuran</span>`,
      iconName: "package",
      tone: "dark",
    })}
    ${statCard({
      label: "Masuk hari ini",
      value: fmtQty(data.today_in?.qty),
      sub: `<span class="up">${esc(fmtM3(data.today_in?.m3))} m³</span><span>·</span><span>Bulan ini ${esc(fmtQty(monthIn.qty))}</span>`,
      iconName: "arrowDownLeft",
      tone: "green",
    })}
    ${statCard({
      label: "Keluar hari ini",
      value: fmtQty(data.today_out?.qty),
      sub: `<span class="down">${esc(fmtM3(data.today_out?.m3))} m³</span><span>·</span><span>Bulan ini ${esc(fmtQty(data.month_out?.qty))}</span>`,
      iconName: "arrowUpRight",
      tone: "amber",
    })}
    ${statCard({
      label: "Pembelian bulan ini",
      value: fmtMoneyShort(monthIn.amount),
      sub: `<span>${esc(fmtMoney(monthIn.amount))}</span>`,
      iconName: "wallet",
      tone: "blue",
    })}
  </div>`;
}

function chartMarkup(series) {
  const maxValue = Math.max(1, ...series.map((point) => Math.max(Number(point.incoming_qty || 0), Number(point.outgoing_qty || 0))));
  const tick = (value) => (value >= 1000 ? `${Math.round(value / 1000)} rb` : fmtQty(value));
  const ticks = [maxValue, maxValue * 0.66, maxValue * 0.33, 0];
  const bars = series.map((point) => {
    const inH = Math.max(2, Math.round((Number(point.incoming_qty || 0) / maxValue) * 100));
    const outH = Math.max(2, Math.round((Number(point.outgoing_qty || 0) / maxValue) * 100));
    return `<div class="chart-month" title="${esc(point.label)}">
      <div class="chart-columns">
        <div class="chart-bar in" style="height:${inH}%" title="Masuk ${esc(fmtQty(point.incoming_qty))} batang · ${esc(fmtM3(point.incoming_m3))} m³"></div>
        <div class="chart-bar out" style="height:${outH}%" title="Keluar ${esc(fmtQty(point.outgoing_qty))} batang · ${esc(fmtM3(point.outgoing_m3))} m³"></div>
      </div>
      <span class="chart-month-label">${esc(point.label)}</span>
    </div>`;
  }).join("");
  const totalIn = series.reduce((sum, point) => sum + Number(point.incoming_m3 || 0), 0);
  const totalOut = series.reduce((sum, point) => sum + Number(point.outgoing_m3 || 0), 0);
  return `<div class="card chart-card">
    <div class="card-header with-line" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div>${sectionHead("Arus barang enam bulan", "Perbandingan batang masuk dan keluar")}</div>
      <div class="chart-legend">
        <span><i class="legend-dot" style="background:#1b6b53"></i> Masuk</span>
        <span><i class="legend-dot" style="background:#cf9f54"></i> Keluar</span>
      </div>
    </div>
    <div class="chart-body">
      <div class="chart-axis">${ticks.map((value) => `<span>${esc(tick(value))}</span>`).join("")}</div>
      <div class="chart-plot">
        <div class="chart-grid"><span></span><span></span><span></span><span></span></div>
        <div class="chart-bars">${bars}</div>
      </div>
    </div>
    <div class="chart-note-row">
      <span>Total masuk <strong>${esc(fmtM3(totalIn))} m³</strong></span>
      <span>Total keluar <strong>${esc(fmtM3(totalOut))} m³</strong></span>
      <span>Selisih <strong>${esc(fmtM3(totalIn - totalOut))} m³</strong></span>
    </div>
    <div style="padding:4px 20px 18px"></div>
  </div>`;
}

function unclosedMarkup(data) {
  const unclosed = data.unclosed;
  if (!unclosed) {
    const next = data.period || {};
    return `<div class="card unclosed-card">
      <div class="card-pad">
        <div style="display:flex;align-items:flex-start;gap:11px">
          <span class="stat-icon" style="background:var(--amber-soft);color:var(--amber-deep);width:36px;height:36px">${icon("checkCircle", 19)}</span>
          <div>
            <span class="mini-label">Pengawasan stok</span>
            <h2 style="font-size:16px;font-weight:650;margin-top:3px">Tidak ada opname terbuka</h2>
            <p style="color:var(--muted);font-size:11px;line-height:1.6;margin-top:4px">Buku stok sedang bersih. Tutup periode secara berkala agar tanggal transaksi terkunci dan laporan tetap rapi.</p>
          </div>
        </div>
        <div class="progress-meta" style="margin-top:14px">
          <span>Saran penghitungan berikutnya</span>
          <strong>${esc(next.suggested_cutoff_display || "—")}</strong>
        </div>
        ${isAdmin() ? `<a class="btn btn-secondary btn-sm btn-block" style="margin-top:12px" href="#/opname?new=1">${icon("plus", 15)} Mulai opname baru</a>` : `<a class="btn btn-secondary btn-sm btn-block" style="margin-top:12px" href="#/opname">${icon("history", 15)} Lihat riwayat opname</a>`}
      </div>
    </div>`;
  }
  const summary = unclosed.summary || {};
  const total = Number(summary.items || 0);
  const counted = Number(summary.counted || 0);
  const percent = total ? Math.round((counted / total) * 100) : 0;
  const statusLabel = unclosed.status === "DONE" ? "Menunggu penutupan" : "Sedang dihitung";
  return `<div class="card unclosed-card">
    <div class="card-pad">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div>
          <span class="mini-label">Opname berjalan</span>
          <h2 style="font-size:16px;font-weight:650;margin-top:3px">${esc(unclosed.period_start_display)} — ${esc(unclosed.period_end_display)}</h2>
        </div>
        <span class="badge ${unclosed.status === "DONE" ? "badge-blue" : "badge-amber"}">${esc(statusLabel)}</span>
      </div>
      <div class="progress-track" style="margin-top:14px"><div class="progress-fill" style="width:${percent}%"></div></div>
      <div class="progress-meta"><span>${esc(counted)} dari ${esc(total)} baris dihitung</span><strong>${percent}%</strong></div>
      <div class="summary-stats" style="grid-template-columns:repeat(3,1fr)">
        <div class="summary-stat"><span>Sistem</span><strong>${esc(fmtQty(summary.system_qty))}</strong></div>
        <div class="summary-stat plus"><span>Lebih</span><strong>+${esc(fmtQty(summary.plus_qty))}</strong></div>
        <div class="summary-stat minus"><span>Kurang</span><strong>−${esc(fmtQty(summary.minus_qty))}</strong></div>
      </div>
      <a class="btn btn-primary btn-sm btn-block" style="margin-top:13px" href="#/opname/${unclosed.id}">${icon("arrowRight", 15)} ${unclosed.status === "DONE" ? "Tinjau hasil opname" : "Lanjutkan penghitungan"}</a>
    </div>
  </div>`;
}

function topProductsMarkup(data) {
  const rows = data.top_products || [];
  return `<div class="card">
    <div class="card-header with-line">${sectionHead("Barang dengan volume terbesar", "Posisi stok per ukuran", '<a class="link" href="#/stock">Lihat stok ' + icon("chevronRight", 14) + "</a>")}</div>
    <div class="card-body" style="padding-top:6px">
      ${rows.length ? rows.map((row, index) => `<div class="top-product">
        <span class="top-product-rank">${index + 1}</span>
        <div class="top-product-copy">
          <strong>${esc(row.name)}</strong>
          <span>${esc(row.code)} · ${esc(row.size_display || row.size || "-")} · ${esc(row.location_count ?? 0)} lokasi</span>
        </div>
        <div class="top-product-value">${esc(fmtM3(row.m3))} m³<span>${esc(fmtQty(row.stock))} batang</span></div>
      </div>`).join("") : `<div class="ws-empty">${icon("package", 22)}Belum ada stok tercatat.</div>`}
    </div>
  </div>`;
}

function activityMarkup(data) {
  const rows = data.recent_activity || [];
  return `<div class="card">
    <div class="card-header with-line">${sectionHead("Aktivitas terakhir", "Jejak kerja terbaru", isAdmin() ? '<a class="link" href="#/activity">Buka log ' + icon("chevronRight", 14) + "</a>" : "")}</div>
    <div class="card-body" style="padding-top:6px">
      ${rows.length ? rows.map((row) => `<div class="activity-row">
        <span class="activity-dot"></span>
        <div class="activity-copy">
          <p><span class="activity-action">${esc(row.action)}</span>${esc(row.detail || "")}</p>
          <span>${esc(row.username)} · ${esc(row.time_display || "")}</span>
        </div>
      </div>`).join("") : `<div class="ws-empty">${icon("pulse", 22)}Belum ada aktivitas.</div>`}
    </div>
  </div>`;
}

function quickMarkup() {
  const items = [
    { href: "#/receiving", icon: "inbox", title: "Penerimaan lokal", text: "Catat rit & nota" },
    { href: "#/imports?scan=1", icon: "scan", title: "Penerimaan impor", text: "Pindai barcode" },
    { href: "#/tally", icon: "tally", title: "Tally & afkir", text: "Periksa mutu" },
    { href: "#/outgoing", icon: "outgoing", title: "Barang keluar", text: "Potong stok lot" },
    { href: "#/transfers", icon: "transfer", title: "Mutasi lokasi", text: "Pindah gudang" },
    { href: "#/reports", icon: "chart", title: "Laporan", text: "Analitik & ekspor" },
  ];
  return `<div class="card card-pad">
    ${sectionHead("Aksi cepat", "Langkah yang sering dipakai")}
    <div class="quick-grid">
      ${items.map((item) => `<a class="quick-action" href="${item.href}">${icon(item.icon, 19)}<strong>${esc(item.title)}</strong><span>${esc(item.text)}</span></a>`).join("")}
    </div>
    <div class="section-divider"></div>
    <div class="inline-meta">
      <span>${icon("users", 13)} <strong>${esc(fmtQty(state.meta?.counts?.products))}</strong> barang aktif</span>
      <span>${icon("mapPin", 13)} <strong>${esc(fmtQty(state.meta?.masters?.locations?.length))}</strong> lokasi</span>
      <span>${icon("tally", 13)} <strong>${esc(fmtQty(state.meta?.counts?.active_tallies))}</strong> tally aktif</span>
    </div>
  </div>`;
}

function locationsMarkup(data) {
  const rows = data.locations || [];
  const maxM3 = Math.max(1, ...rows.map((row) => Number(row.m3 || 0)));
  return `<div class="card">
    <div class="card-header with-line">${sectionHead("Sebaran persediaan", "Volume per lokasi", '<a class="link" href="#/stock">Detail ' + icon("chevronRight", 14) + "</a>")}</div>
    <div class="card-body">
      ${rows.length ? `<div class="location-bars">${rows.slice(0, 7).map((row) => `<div class="location-row">
        <div class="loc-top"><strong>${esc(row.location)}</strong><span>${esc(fmtM3(row.m3))} m³ · ${esc(fmtQty(row.qty))}</span></div>
        <div class="location-track"><div class="location-fill" style="width:${Math.max(2, Math.round((Number(row.m3 || 0) / maxM3) * 100))}%"></div></div>
      </div>`).join("")}</div>` : `<div class="loc-empty">Belum ada persediaan tersebar.</div>`}
    </div>
  </div>`;
}

function notesMarkup() {
  const tallies = Number(state.meta?.counts?.active_tallies || 0);
  const recaps = Number(state.meta?.counts?.active_recaps || 0);
  return `<div class="card">
    <div class="card-header with-line">${sectionHead("Dokumen berjalan", "Tally dan rekap yang masih aktif")}</div>
    <div class="card-body">
      <div class="detail-row"><span>Tally aktif</span><strong>${esc(fmtQty(tallies))} dokumen</strong></div>
      <div class="detail-row"><span>Rekap pembayaran aktif</span><strong>${esc(fmtQty(recaps))} dokumen</strong></div>
      <div class="detail-row"><span>Periode terkunci sampai</span><strong>${esc(state.meta?.lock?.locked_through_display || "Belum dikunci")}</strong></div>
      <div class="detail-row"><span>Penutupan terakhir</span><strong>${esc(state.meta?.period?.last_closed_display || "Belum ada")}</strong></div>
      <div class="pill-row" style="margin-top:13px">
        <a class="btn btn-secondary btn-sm" href="#/tally">${icon("tally", 15)} Tally</a>
        <a class="btn btn-secondary btn-sm" href="#/recap">${icon("receipt", 15)} Rekap</a>
      </div>
    </div>
  </div>`;
}

export async function render(root, { rerender }) {
  root.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat ringkasan gudang…</span></div>`;
  let data;
  try {
    data = await api.get("/api/dashboard");
  } catch (error) {
    root.innerHTML = `<div class="card card-pad"><div class="error-state"><span class="error-icon">${icon("alert", 24)}</span><div><strong>Dasbor belum dapat dimuat</strong><p>${esc(error.message || "Terjadi kesalahan.")}</p></div><button class="btn btn-secondary btn-sm" type="button" data-retry>${icon("refresh", 16)} Coba lagi</button></div></div>`;
    root.querySelector("[data-retry]")?.addEventListener("click", () => rerender());
    return;
  }
  root.innerHTML = `
    ${heroMarkup(data)}
    ${kpiMarkup(data)}
    <div class="dash-top">
      ${chartMarkup(data.series || [])}
      ${unclosedMarkup(data)}
    </div>
    <div class="dash-bottom">
      ${topProductsMarkup(data)}
      ${activityMarkup(data)}
    </div>
    <div class="dash-cols-lower">
      ${quickMarkup()}
      ${locationsMarkup(data)}
    </div>
    <div style="margin-top:16px">${notesMarkup()}</div>
    <div class="text-muted" style="font-size:10px;text-align:right;margin-top:12px">Ringkasan per ${esc(fmtDate(data.today))} · ${esc(fmtDateFull(data.today))}</div>
  `;
  refreshAllMeta().catch(() => {});
}
