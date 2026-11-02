import { api } from "../api.js";
import { icon } from "../icons.js";
import {
  badge, esc, firstOfMonth, fmtDate, fmtM3, fmtMoney, fmtQty, fmtSize,
  openDrawer, openForm, toast, todayISO,
} from "../ui.js";
import {
  downloadExport, locations, pageHead,
} from "./common.js";

const state = {
  start: firstOfMonth(),
  end: todayISO(),
  query: "",
  data: null,
  parsed: null,
};

let stream = null;
let detectorTimer = null;

function layout() {
  return `${pageHead({
    eyebrow: "Penerimaan impor",
    title: "Penerimaan Impor",
    subtitle: "Pindai barcode, urai dokumen, dan catat lot kayu impor dengan ukuran bebas.",
    actions: `<button class="btn btn-secondary" type="button" data-export>${icon("download", 16)} Ekspor</button>
      <button class="btn btn-primary" type="button" data-create-import>${icon("plus", 16)} Catat impor</button>`,
  })}
  <div class="import-layout">
    <div class="stack">
      <form class="filters" id="import-filters" style="margin-bottom:0">
        <div class="field"><label class="field-label" for="imp-start">Dari</label><input class="input" id="imp-start" type="date" value="${esc(state.start)}"></div>
        <div class="field"><label class="field-label" for="imp-end">Sampai</label><input class="input" id="imp-end" type="date" value="${esc(state.end)}"></div>
        <div class="field grow-field"><label class="field-label" for="imp-query">Cari</label><input class="input" id="imp-query" type="search" value="${esc(state.query)}" placeholder="Nomor, barcode, barang, pemasok…"></div>
        <div class="filter-actions"><button class="btn btn-secondary" type="submit">${icon("search", 15)} Terapkan</button></div>
      </form>
      <div class="card card-flush">
        <div class="card-header with-line stock-toolbar" style="padding-bottom:14px">
          <div><h2 style="font-size:15px;font-weight:650">Riwayat penerimaan impor</h2><p style="color:var(--muted);font-size:11px;margin-top:2px" id="import-range">—</p></div>
          <div class="stock-totals" id="import-totals"></div>
        </div>
        <div id="import-table"><div class="loading-block"><span class="spinner"></span><span>Memuat data impor…</span></div></div>
      </div>
    </div>
    <aside class="import-panel">
      <div class="card">
        <div class="card-pad">
          <div class="scanner-box">
            <div class="scanner-head">
              <span class="scanner-icon">${icon("scan", 17)}</span>
              <div><strong>Pindai barcode / dokumen</strong><span>Tempel teks atau nyalakan kamera</span></div>
            </div>
            <textarea class="input" id="import-payload" rows="3" placeholder='cth. {"barcode":"IMP-99213","product_name":"KAYU MERANTI","size":"20x40x400","qty":12,"price":7200000,"location":"GD-A"}'></textarea>
            <div class="scanner-actions">
              <button class="btn btn-secondary" type="button" data-parse>${icon("sparkles", 14)} Urai data</button>
              <button class="btn btn-secondary" type="button" data-camera>${icon("camera", 14)} Kamera</button>
              <button class="btn btn-ghost" type="button" data-clear-payload>${icon("x", 14)} Bersihkan</button>
            </div>
          </div>
          <div id="camera-box"></div>
          <div id="parse-preview"></div>
          <div class="separator" style="height:1px;background:var(--line);margin:14px 0"></div>
          <div class="stack-sm">
            <button class="btn btn-primary btn-block" type="button" data-create-import>${icon("plus", 15)} Catat penerimaan impor</button>
            <button class="btn btn-secondary btn-block" type="button" data-create-from-scan disabled id="btn-from-scan">${icon("scan", 15)} Gunakan hasil pindai</button>
          </div>
          <p class="field-help" style="margin-top:10px">Barang impor dibuat otomatis dengan kode <span class="code-chip">IMP/NAMA</span>. Ukuran bebas, tidak terikat master ukuran lokal.</p>
        </div>
      </div>
    </aside>
  </div>`;
}

function renderTable() {
  const holder = document.getElementById("import-table");
  if (!holder) return;
  const data = state.data;
  if (!data) {
    holder.innerHTML = `<div class="loading-block"><span class="spinner"></span><span>Memuat data impor…</span></div>`;
    return;
  }
  document.getElementById("import-range").textContent = `${data.start_display} — ${data.end_display}`;
  document.getElementById("import-totals").innerHTML = `
    <span class="stock-total-item"><strong>${esc(fmtQty(data.totals.count))}</strong> dokumen</span>
    <span class="stock-total-item"><strong>${esc(fmtQty(data.totals.qty))}</strong> batang</span>
    <span class="stock-total-item"><strong>${esc(fmtM3(data.totals.m3))}</strong> m³</span>
    <span class="stock-total-item"><strong>${esc(fmtMoney(data.totals.amount))}</strong></span>`;
  if (!data.rows.length) {
    holder.innerHTML = `<div class="empty-state" style="padding:40px 18px"><span class="empty-icon">${icon("import", 26)}</span><strong>Belum ada penerimaan impor</strong><p>Gunakan panel pindai untuk mencatat lot impor pertama pada periode ini.</p></div>`;
    return;
  }
  holder.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
    <th>Tanggal</th><th>Dokumen</th><th>Barang</th><th>Ukuran (T×L×P)</th><th class="num">Qty</th><th class="num">m³</th><th class="num">Nilai</th><th>Pemasok</th><th>Lokasi</th><th></th>
  </tr></thead><tbody>
    ${data.rows.map((row) => `<tr class="is-clickable" data-import="${row.id}" data-context-open="[data-import='${row.id}']">
      <td><div class="cell-title">${esc(fmtDate(row.trx_date))}</div><div class="cell-sub">${esc(row.trx_number)}</div></td>
      <td><div class="doc-number">${esc(row.document_number || "—")}</div>${row.barcode ? `<span class="barcode-chip" title="${esc(row.barcode)}">${icon("barcode", 11)} ${esc(row.barcode)}</span>` : ""}</td>
      <td><div class="cell-title">${esc(row.name)}</div><div class="cell-sub">${esc(row.code)}</div></td>
      <td><span class="size">${esc(row.size_display)}</span></td>
      <td class="num">${esc(fmtQty(row.qty))}</td>
      <td class="num">${esc(fmtM3(row.m3))}</td>
      <td class="num strong">${esc(fmtMoney(row.amount))}</td>
      <td>${esc(row.supplier || "—")}</td>
      <td><span class="loc">${icon("mapPin", 12)} ${esc(row.location || "—")}</span></td>
      <td><div class="row-actions"><button class="icon-btn" type="button" data-import="${row.id}" title="Detail">${icon("eye", 15)}</button></div></td>
    </tr>`).join("")}
  </tbody></table></div>
  <div class="table-footer"><span>Menampilkan <strong>${esc(fmtQty(data.rows.length))}</strong> dokumen</span><span>Total ${esc(fmtM3(data.totals.m3))} m³</span></div>`;
}

async function loadImports() {
  state.data = null;
  renderTable();
  try {
    state.data = await api.get("/api/imports", { start: state.start, end: state.end, query: state.query });
    renderTable();
  } catch (error) {
    document.getElementById("import-table").innerHTML = `<div class="empty-state" style="padding:34px">${icon("alert", 24)}<strong>Data impor gagal dimuat</strong><p>${esc(error.message)}</p></div>`;
  }
}

function importFields(values = {}) {
  const locOpts = locations();
  return [
    { name: "product_name", label: "Nama barang / jenis kayu", type: "text", required: true, maxlength: 120, full: true, value: values.product_name || "", placeholder: "cth. KAYU MERANTI" },
    { name: "date", label: "Tanggal terima", type: "date", required: true, max: todayISO(), value: values.date || todayISO() },
    { name: "number", label: "Nomor dokumen", type: "text", maxlength: 80, value: values.number || "", placeholder: "Invoice / packing list" },
    { name: "thickness", label: "Tebal (T, mm)", type: "number", required: true, min: 1, step: 1, value: values.thickness || "", placeholder: "cth. 40", help: "Satuan milimeter." },
    { name: "width", label: "Lebar (L, cm)", type: "number", required: true, min: 1, step: 1, value: values.width || "", placeholder: "cth. 20", help: "Satuan sentimeter." },
    { name: "length", label: "Panjang (P, cm)", type: "number", required: true, min: 1, step: 1, value: values.length || "", placeholder: "cth. 400", help: "Satuan sentimeter." },
    { name: "qty", label: "Jumlah batang", type: "number", required: true, min: 0.0001, step: "any", value: values.qty ?? "" },
    { name: "price", label: "Harga per m³", type: "number", min: 0, step: "any", value: values.price ?? 0 },
    locOpts.length
      ? { name: "location", label: "Lokasi gudang", type: "select", required: true, options: locOpts, value: values.location || "" }
      : { name: "location", label: "Lokasi gudang", type: "text", required: true, value: values.location || "" },
    { name: "supplier", label: "Pemasok / asal", type: "text", maxlength: 120, value: values.supplier || "" },
    { name: "barcode", label: "Barcode", type: "text", maxlength: 120, value: values.barcode || "", placeholder: "Opsional" },
    { name: "note", label: "Catatan", type: "textarea", rows: 2, maxlength: 300, full: true, value: values.note || "" },
  ];
}

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return todayISO();
}

function dimensionsFromParsed(parsed = {}) {
  const dims = {
    thickness: parsed.thickness || "",
    width: parsed.width || "",
    length: parsed.length || "",
  };
  if (!dims.thickness || !dims.width || !dims.length) {
    const parts = String(parsed.size || "").split(/[x×,\s]+/).filter(Boolean);
    if (parts.length === 3) {
      dims.width = dims.width || parts[0];
      dims.thickness = dims.thickness || parts[1];
      dims.length = dims.length || parts[2];
    }
  }
  return dims;
}

function openCreateForm(values = {}) {
  const dims = dimensionsFromParsed(values);
  const initial = {
    ...values,
    ...dims,
    date: normalizeDateInput(values.date),
  };
  openForm({
    title: "Catat penerimaan impor",
    eyebrow: "Penerimaan impor",
    subtitle: "Barang impor tidak memakai master ukuran lokal.",
    size: "lg",
    fields: importFields(initial),
    submitLabel: "Simpan penerimaan",
    submitIcon: "import",
    intro: `<div class="inline-meta"><span>${icon("barcode", 13)} Barcode disimpan pada catatan lot.</span><span>${icon("sparkles", 13)} Barang dibuat otomatis bila belum ada.</span></div>`,
    onSubmit: async (formValues) => {
      const payload = {
        ...formValues,
        price: formValues.price === "" ? 0 : formValues.price,
      };
      const result = await api.post("/api/imports", { fields: payload });
      toast.success(`${result.trx_number} tersimpan.`);
      clearScan();
      await loadImports();
    },
  });
}

function openEditForm(row) {
  openForm({
    title: `Ubah ${row.trx_number}`,
    eyebrow: "Penerimaan impor",
    subtitle: `${row.name} · ${row.size_display}`,
    size: "md",
    fields: [
      { name: "date", label: "Tanggal terima", type: "date", required: true, max: todayISO(), value: row.trx_date?.slice(0, 10) || todayISO() },
      { name: "qty", label: `Jumlah batang (terpakai ${fmtQty(row.used)})`, type: "number", required: true, min: Math.max(row.used, 0.0001), step: "any", value: row.qty },
      { name: "price", label: "Harga per m³", type: "number", min: 0, step: "any", value: row.price },
      { name: "supplier", label: "Pemasok / asal", type: "text", maxlength: 120, value: row.supplier || "" },
      { name: "barcode", label: "Barcode", type: "text", maxlength: 120, value: row.barcode || "" },
      { name: "note", label: "Catatan", type: "textarea", rows: 2, maxlength: 300, full: true, value: row.user_note || "" },
    ],
    submitLabel: "Simpan perubahan",
    submitIcon: "save",
    intro: row.used > 0 ? `<div class="inline-meta">${icon("alert", 14)} Qty tidak boleh lebih kecil dari pemakaian ${esc(fmtQty(row.used))} batang.</div>` : "",
    onSubmit: async (values) => {
      await api.put(`/api/imports/${row.id}`, values);
      toast.success("Penerimaan impor diperbarui.");
      await loadImports();
    },
  });
}

async function openDetail(id) {
  const drawer = openDrawer({
    title: "Detail penerimaan impor",
    eyebrow: "Penerimaan impor",
    size: "md",
    body: `<div class="loading-block"><span class="spinner"></span><span>Memuat dokumen…</span></div>`,
  });
  try {
    const row = await api.get(`/api/imports/${id}`);
    const remaining = Number(row.qty || 0) - Number(row.used || 0);
    drawer.bodyEl.innerHTML = `
      <div class="note-detail-head">
        <div><h2 style="font-size:18px;font-weight:650">${esc(row.name)}</h2><div class="inline-meta" style="margin-top:4px"><span class="code-chip">${esc(row.code)}</span><span class="doc-number">${esc(row.trx_number)}</span></div></div>
        ${badge(`${fmtQty(remaining)} tersisa`, remaining > 0 ? "green" : "neutral")}
      </div>
      <div class="meta-grid">
        <div class="meta-cell"><span>Tanggal</span><strong>${esc(fmtDate(row.trx_date))}</strong></div>
        <div class="meta-cell"><span>Ukuran</span><strong>${esc(row.size_display)}</strong></div>
        <div class="meta-cell"><span>Qty masuk</span><strong>${esc(fmtQty(row.qty))} batang</strong></div>
        <div class="meta-cell"><span>Sudah keluar</span><strong>${esc(fmtQty(row.used))} batang</strong></div>
        <div class="meta-cell"><span>Volume</span><strong>${esc(fmtM3(row.volume))} m³</strong></div>
        <div class="meta-cell"><span>Harga / m³</span><strong>${esc(fmtMoney(row.price))}</strong></div>
        <div class="meta-cell"><span>Lokasi</span><strong>${esc(row.location || "—")}</strong></div>
        <div class="meta-cell"><span>Nilai lot</span><strong>${esc(fmtMoney(row.amount))}</strong></div>
      </div>
      <div class="section-divider"></div>
      <div class="detail-row"><span>Pemasok</span><strong>${esc(row.supplier || "—")}</strong></div>
      <div class="detail-row"><span>Nomor dokumen</span><strong>${esc(row.delivery_number || "—")}</strong></div>
      <div class="detail-row"><span>Barcode</span><strong>${row.barcode ? `<span class="barcode-chip">${icon("barcode", 12)} ${esc(row.barcode)}</span>` : "—"}</strong></div>
      <div class="detail-row"><span>Dicatat oleh</span><strong>${esc(row.username || "—")}</strong></div>
      <div class="detail-row"><span>Catatan</span><strong>${esc(row.user_note || "—")}</strong></div>
      <div class="section-divider"></div>
      <div class="toolbar-row">
        <button class="btn btn-primary btn-sm" type="button" data-edit-import="${row.id}">${icon("edit", 15)} Ubah penerimaan</button>
        <button class="btn btn-secondary btn-sm" type="button" data-open-lot>${icon("package", 15)} Lihat stok & lot</button>
      </div>`;
    drawer.bodyEl.querySelector("[data-edit-import]")?.addEventListener("click", () => {
      drawer.close();
      openEditForm({ ...row, trx_date: row.trx_date });
    });
    drawer.bodyEl.querySelector("[data-open-lot]")?.addEventListener("click", () => {
      drawer.close();
      location.hash = `#/stock?product=${row.product_id || ""}`;
    });
  } catch (error) {
    drawer.close();
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ scanner */

function stopCamera() {
  if (detectorTimer) {
    window.clearInterval(detectorTimer);
    detectorTimer = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  const box = document.getElementById("camera-box");
  if (box) box.innerHTML = "";
}

async function startCamera() {
  const box = document.getElementById("camera-box");
  if (!box) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast.warn("Kamera tidak tersedia pada perangkat ini.");
    return;
  }
  if (!("BarcodeDetector" in window)) {
    toast.warn("Browser ini belum mendukung pemindaian barcode otomatis. Gunakan input manual atau tempel teks.");
    return;
  }
  if (stream) {
    stopCamera();
    return;
  }
  box.innerHTML = `<div class="camera-stage"><video autoplay playsinline muted></video><div class="camera-reticle"></div></div>
    <div class="scanner-actions"><span class="notice-line" style="flex:1">${icon("scan", 14)} Arahkan barcode ke dalam bingkai…</span><button class="btn btn-secondary btn-sm" type="button" data-stop-camera>${icon("x", 14)} Hentikan</button></div>`;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = box.querySelector("video");
    video.srcObject = stream;
    await video.play().catch(() => {});
    const detector = new window.BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "qr_code", "itf"] });
    detectorTimer = window.setInterval(async () => {
      if (!video.videoWidth) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length && codes[0].rawValue) {
          const payload = document.getElementById("import-payload");
          if (payload) payload.value = codes[0].rawValue;
          stopCamera();
          toast.success("Barcode terbaca. Lengkapi data lalu urai.");
        }
      } catch {
        /* deteksi dilewati */
      }
    }, 900);
  } catch (error) {
    stopCamera();
    toast.error(error.name === "NotAllowedError" ? "Izin kamera ditolak." : "Kamera tidak dapat dinyalakan.");
  }
  box.querySelector("[data-stop-camera]")?.addEventListener("click", stopCamera);
}

function clearScan() {
  stopCamera();
  state.parsed = null;
  const preview = document.getElementById("parse-preview");
  if (preview) preview.innerHTML = "";
  const button = document.getElementById("btn-from-scan");
  if (button) button.disabled = true;
  const payload = document.getElementById("import-payload");
  if (payload) payload.value = "";
}

function renderParsed(parsed) {
  state.parsed = parsed;
  const preview = document.getElementById("parse-preview");
  const button = document.getElementById("btn-from-scan");
  if (!preview) return;
  const sizeText = parsed.size || [parsed.thickness, parsed.width, parsed.length].filter(Boolean).join("×");
  const cells = [
    ["Barang", parsed.product_name || "—"],
    ["Ukuran", sizeText ? fmtSize(sizeText) : "—"],
    ["Qty", parsed.qty ? `${fmtQty(parsed.qty)} batang` : "—"],
    ["Harga", parsed.price ? fmtMoney(parsed.price) : "—"],
    ["Pemasok", parsed.supplier || "—"],
    ["Lokasi", parsed.location || "—"],
    ["Dokumen", parsed.number || "—"],
    ["Barcode", parsed.barcode || "—"],
    ["Tanggal", parsed.date ? fmtDate(parsed.date) : "hari ini"],
  ];
  preview.innerHTML = `<div class="import-grid-preview">${cells.map(([label, value]) => `<div class="import-preview-cell"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")}</div>
    <p class="field-help">Periksa hasil urai. Kolom yang belum terbaca dapat dilengkapi pada formulir.</p>`;
  if (button) button.disabled = false;
}

async function parsePayload() {
  const payload = document.getElementById("import-payload")?.value.trim();
  if (!payload) {
    toast.warn("Tempel atau pindai data terlebih dahulu.");
    document.getElementById("import-payload")?.focus();
    return;
  }
  const button = document.querySelector("[data-parse]");
  button.disabled = true;
  try {
    const data = await api.post("/api/imports/parse", { payload });
    renderParsed(data.parsed || {});
  } catch (error) {
    toast.error(error.message);
  } finally {
    button.disabled = false;
  }
}

async function exportData(button) {
  if (state.data && !state.data.rows.length) {
    toast.info("Tidak ada data untuk diekspor.");
    return;
  }
  await downloadExport("imports", { start: state.start, end: state.end, query: state.query }, "penerimaan-impor.xlsx", button);
}

export async function render(root, { query }) {
  root.innerHTML = layout();
  await loadImports();
  if (query?.get("scan") === "1") {
    window.setTimeout(() => document.getElementById("import-payload")?.focus(), 250);
  }
  document.getElementById("import-filters").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.start = document.getElementById("imp-start").value || firstOfMonth();
    state.end = document.getElementById("imp-end").value || todayISO();
    state.query = document.getElementById("imp-query").value.trim();
    await loadImports();
  });
  root.addEventListener("click", async (event) => {
    if (event.target.closest("[data-export]")) {
      await exportData(event.target.closest("[data-export]"));
      return;
    }
    if (event.target.closest("[data-create-import]")) {
      openCreateForm();
      return;
    }
    if (event.target.closest("[data-parse]")) {
      await parsePayload();
      return;
    }
    if (event.target.closest("[data-camera]")) {
      await startCamera();
      return;
    }
    if (event.target.closest("[data-stop-camera]")) {
      stopCamera();
      return;
    }
    if (event.target.closest("[data-clear-payload]")) {
      clearScan();
      return;
    }
    if (event.target.closest("[data-create-from-scan]")) {
      if (!state.parsed) {
        toast.warn("Urai payload terlebih dahulu.");
        return;
      }
      const parsed = state.parsed;
      openCreateForm({
        ...parsed,
        date: parsed.date,
        size: parsed.size,
      });
      return;
    }
    const row = event.target.closest("[data-import]");
    if (row) {
      await openDetail(Number(row.dataset.import));
    }
  });
  return () => stopCamera();
}
