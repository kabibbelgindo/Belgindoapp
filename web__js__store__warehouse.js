/* Port server/opname.py + server/reports.py + penyusun ekspor (CSV). */

import {
  AppError, EPS, OPNAME_REASON_OTHER, OPNAME_REASONS, displayDate, fmtQty,
  isoDate, m3Value, moneyText, normalizeSize, parseISODate, pyRound,
  sizeDisplay, sizeParts, todayISO, trimNumber, pad2, dateObject,
} from "./core.js";
import {
  assertPeriodOpen, listRecaps, listTallies, listTransfers, listImports,
  lockedThrough, nocase, priceReference, resolveLocation, stockCard,
  stockMap, stockGrouped, stockRows, sqlLoc, sqlSize, log, validateDimensionsStandard,
} from "./flow.js";

const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function fmtDateValue(value) {
  return value ? displayDate(String(value).slice(0, 10)) : "-";
}

function qtyText(value) {
  return fmtQty(value);
}

export function sessionStatus(row) {
  if (row.closure_id) return "DITUTUP";
  return row.status === "DONE" ? "DISAHKAN" : "PENGHITUNGAN";
}

/* --------------------------------------------------------- stok opname */

export function listSessions(d) {
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  const rows = d.all("stock_opname")
    .slice()
    .sort((a, b) => {
      const endA = String(a.period_end || "");
      const endB = String(b.period_end || "");
      if (endA !== endB) return endA < endB ? 1 : -1;
      return Number(b.id) - Number(a.id);
    });
  return rows.map((row) => {
    const closure = d.where("stock_period_closures", (item) => Number(item.opname_id) === Number(row.id));
    return {
      ...row,
      closure_id: closure?.id ?? null,
      closed_at: closure?.closed_at ?? null,
      created_by_name: users.get(Number(row.user_id))?.username ?? null,
      approved_by_name: users.get(Number(row.approved_by))?.username ?? null,
      item_count: d.filter("stock_opname_items", (item) => Number(item.opname_id) === Number(row.id)).length,
      label_status: null,
      period_start_display: fmtDateValue(row.period_start),
      period_end_display: fmtDateValue(row.period_end),
      created_display: fmtDateValue(String(row.created_at || "").slice(0, 10)),
      closed_display: closure?.closed_at ? fmtDateValue(String(closure.closed_at).slice(0, 10)) : null,
    };
  }).map((row) => ({ ...row, label_status: sessionStatus(row) }));
}

export function unclosedSession(d) {
  const rows = d.all("stock_opname")
    .filter((row) => !d.where("stock_period_closures", (item) => Number(item.opname_id) === Number(row.id)))
    .slice()
    .sort((a, b) => {
      const endA = String(a.period_end || "");
      const endB = String(b.period_end || "");
      if (endA !== endB) return endA < endB ? 1 : -1;
      return Number(b.id) - Number(a.id);
    });
  return rows[0] || null;
}

export function lastClosure(d) {
  const rows = d.all("stock_period_closures")
    .slice()
    .sort((a, b) => {
      const endA = String(a.period_end || "");
      const endB = String(b.period_end || "");
      if (endA !== endB) return endA < endB ? 1 : -1;
      return Number(b.id) - Number(a.id);
    });
  return rows[0] || null;
}

export function nextPeriodStart(d) {
  const closure = lastClosure(d);
  if (closure) {
    return [dateObject(parseISODate(addDaysParts(closure.period_end, 1))), false];
  }
  const first = d.all("transactions").reduce((acc, row) => {
    const value = String(row.trx_date).slice(0, 10);
    return !acc || value < acc ? value : acc;
  }, null);
  if (first) return [dateObject(parseISODate(first)), true];
  return [dateObject(parseISODate(todayISO())), true];
}

function addDaysParts(isoValue, days) {
  const { year, month, day } = parseISODate(isoValue);
  const probe = new Date(year, month - 1, day + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${probe.getFullYear()}-${pad(probe.getMonth() + 1)}-${pad(probe.getDate())}`;
}

export function defaultCutoff(start, today = null) {
  const todayDate = today ? parseISODate(today) : parseISODate(todayISO());
  const startParts = typeof start === "string" ? parseISODate(start) : start;
  const firstNext = new Date(startParts.year + (startParts.month === 12 ? 1 : 0), startParts.month % 12, 1);
  const monthEnd = new Date(firstNext.getFullYear(), firstNext.getMonth(), 0);
  const pad = (n) => String(n).padStart(2, "0");
  const monthEndIso = `${monthEnd.getFullYear()}-${pad(monthEnd.getMonth() + 1)}-${pad(monthEnd.getDate())}`;
  const todayIso = `${todayDate.year}-${pad(todayDate.month)}-${pad(todayDate.day)}`;
  return monthEndIso < todayIso ? monthEndIso : todayIso;
}

export function nextPeriodInfo(d) {
  const [start, first] = nextPeriodStart(d);
  const closure = lastClosure(d);
  const pad = (n) => String(n).padStart(2, "0");
  const startIso = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const cutoff = defaultCutoff(startIso);
  return {
    start: startIso,
    start_display: displayDate(startIso),
    first,
    suggested_cutoff: cutoff,
    suggested_cutoff_display: displayDate(cutoff),
    last_closed: closure ? closure.period_end : null,
    last_closed_display: closure ? displayDate(closure.period_end) : null,
    unclosed: unclosedSession(d),
  };
}

function draftLock(d, opnameId) {
  const session = d.one("stock_opname", Number(opnameId));
  if (!session) throw new AppError("Sesi opname tidak ditemukan.", 404);
  if (session.status !== "DRAFT") {
    throw new AppError("Opname sudah disahkan dan terkunci. Gunakan Buka Kembali Pengesahan bila perlu koreksi.");
  }
  if (d.where("stock_period_closures", (row) => Number(row.opname_id) === Number(opnameId))) {
    throw new AppError("Periode opname sudah ditutup dan tidak dapat diubah.");
  }
  return session;
}

export function createSession(d, userId, start, end) {
  const startParts = parseISODate(start, "Tanggal mulai");
  const endParts = parseISODate(end, "Tanggal cut-off");
  const pending = unclosedSession(d);
  if (pending) {
    throw new AppError(
      `Periode ${fmtDateValue(pending.period_start)} s.d. ${fmtDateValue(pending.period_end)} belum ditutup. `
      + "Sahkan dan tutup periode tersebut sebelum membuat periode baru.",
    );
  }
  const [expected, first] = nextPeriodStart(d);
  const pad = (n) => String(n).padStart(2, "0");
  const expectedIso = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`;
  const startIso = `${startParts.year}-${pad(startParts.month)}-${pad(startParts.day)}`;
  const endIso = `${endParts.year}-${pad(endParts.month)}-${pad(endParts.day)}`;
  const today = todayISO();
  if (!first && startIso !== expectedIso) {
    throw new AppError(`Periode baru harus dimulai ${fmtDateValue(expectedIso)} (sehari setelah penutupan terakhir).`);
  }
  if (endIso < startIso) throw new AppError("Tanggal cut-off tidak boleh sebelum tanggal mulai.");
  if (endIso > today) throw new AppError("Tanggal cut-off tidak boleh melewati hari ini.");
  const snapshot = stockRows(d, endIso);
  const pendingAgain = unclosedSession(d);
  if (pendingAgain) throw new AppError("Periode lain baru saja dibuat. Muat ulang halaman Stok Opname.");
  const opnameId = d.allocate("stock_opname");
  d.insert("stock_opname", {
    id: opnameId,
    period_year: endParts.year, period_month: endParts.month,
    period_start: startIso, period_end: endIso, status: "DRAFT",
    user_id: userId ? Number(userId) : null, approved_by: null,
    created_at: d.now, completed_at: null,
  });
  for (const row of snapshot) {
    const itemId = d.allocate("stock_opname_items");
    d.insert("stock_opname_items", {
      id: itemId, opname_id: opnameId, product_id: Number(row.product_id),
      trx_size: row.size || "", system_qty: Number(row.stock), physical_qty: null,
      location: row.location || "", note: "", reason: "",
    });
  }
  log(d, userId, "OPNAME_BUAT",
    `#${opnameId} | ${startIso} s.d. ${endIso} | item=${snapshot.length}`,
    "stock_opname", opnameId);
  return opnameId;
}

function refreshItemsLocked(d, session) {
  const cutoff = String(session.period_end).slice(0, 10);
  const snapshot = stockRows(d, cutoff);
  const smap = new Map(snapshot.map((row) => [`${Number(row.product_id)}|${row.size || ""}|${row.location || ""}`, row]));
  const items = d.filter("stock_opname_items", (row) => Number(row.opname_id) === Number(session.id));
  const seen = new Set();
  let updated = 0;
  let removed = 0;
  let added = 0;
  for (const item of items) {
    const key = `${Number(item.product_id)}|${normalizeSize(item.trx_size)}|${item.location || ""}`;
    seen.add(key);
    const latest = smap.has(key) ? Number(smap.get(key).stock) : 0;
    if (Math.abs(Number(item.system_qty || 0) - latest) > EPS) {
      d.update("stock_opname_items", Number(item.id), { system_qty: latest });
      updated += 1;
    }
    if (item.physical_qty === null && !smap.has(key) && Math.abs(latest) < EPS) {
      d.delete("stock_opname_items", Number(item.id));
      removed += 1;
    }
  }
  for (const [key, row] of smap.entries()) {
    if (seen.has(key)) continue;
    const [productId, size, location] = key.split("|");
    const itemId = d.allocate("stock_opname_items");
    d.insert("stock_opname_items", {
      id: itemId, opname_id: Number(session.id), product_id: Number(productId),
      trx_size: size, system_qty: Number(row.stock), physical_qty: null,
      location: location || "", note: "", reason: "",
    });
    added += 1;
  }
  return { added, updated, removed };
}

export function refreshItems(d, userId, opnameId) {
  const session = draftLock(d, opnameId);
  const result = refreshItemsLocked(d, session);
  log(d, userId, "OPNAME_REFRESH",
    `#${opnameId} | tambah=${result.added} | ubah=${result.updated} | hapus=${result.removed}`,
    "stock_opname", Number(opnameId));
  return result;
}

export function loadItems(d, opnameId) {
  const products = new Map(d.all("products").map((row) => [Number(row.id), row]));
  const rows = d.filter("stock_opname_items", (row) => Number(row.opname_id) === Number(opnameId))
    .map((row) => ({ row, product: products.get(Number(row.product_id)) }))
    .filter((entry) => entry.product)
    .sort((a, b) => nocase(a.product.name, b.product.name)
      || (a.row.trx_size < b.row.trx_size ? -1 : a.row.trx_size > b.row.trx_size ? 1 : 0)
      || (a.row.location < b.row.location ? -1 : a.row.location > b.row.location ? 1 : 0))
    .map(({ row, product }) => {
      const physical = row.physical_qty === undefined ? null : row.physical_qty;
      const diff = physical === null ? null : Number(physical) - Number(row.system_qty || 0);
      return {
        ...row,
        code: product.code, name: product.name, unit: product.unit,
        purchase_price: product.purchase_price,
        size_display: sizeDisplay(row.trx_size),
        system_display: fmtQty(row.system_qty),
        diff: diff === null ? null : pyRound(diff, 4),
        diff_display: diff === null ? "—" : fmtQty(diff),
        diff_m3: diff === null ? null : pyRound(m3Value(row.trx_size, Math.abs(diff)), 6),
        counted: physical !== null && physical !== undefined,
      };
    });
  return rows;
}

function cleanReason(reason) {
  const value = String(reason || "").trim();
  if (value && !OPNAME_REASONS.includes(value)) throw new AppError("Alasan selisih tidak dikenal.");
  return value;
}

export function setCount(d, userId, opnameId, itemId, physical, reason = "", note = "") {
  let physicalValue = physical;
  if (physicalValue !== null && physicalValue !== undefined && physicalValue !== "") {
    physicalValue = Number(physicalValue);
    if (!Number.isFinite(physicalValue)) throw new AppError("Stok fisik harus berupa angka.");
    if (physicalValue < 0) throw new AppError("Stok fisik tidak boleh negatif.");
  } else {
    physicalValue = null;
  }
  const cleanReasonValue = cleanReason(reason);
  const cleanNote = String(note || "").trim();
  if (cleanNote.length > 300) throw new AppError("Catatan maksimal 300 karakter.");
  draftLock(d, opnameId);
  const item = d.one("stock_opname_items", Number(itemId));
  if (!item || Number(item.opname_id) !== Number(opnameId)) {
    throw new AppError("Baris opname tidak ditemukan; muat ulang daftar.");
  }
  d.update("stock_opname_items", Number(itemId), {
    physical_qty: physicalValue, reason: cleanReasonValue, note: cleanNote,
  });
  if (physicalValue !== null) {
    log(d, userId, "OPNAME_HITUNG",
      `#${opnameId} | item=${itemId} | fisik=${fmtQty(physicalValue)} | alasan=${cleanReasonValue || "-"}`,
      "stock_opname", Number(opnameId));
  }
  return { saved: true };
}

export function addFoundItem(d, userId, opnameId, productId, size, location, physical,
  reason = "Barang temuan", note = "") {
  const physicalValue = Number(physical);
  if (!Number.isFinite(physicalValue)) throw new AppError("Isi stok fisik untuk barang temuan.");
  if (physicalValue < 0) throw new AppError("Stok fisik tidak boleh negatif.");
  const normalized = normalizeSize(size);
  if (!normalized) throw new AppError("Ukuran barang temuan wajib diisi.");
  const product = d.one("products", Number(productId));
  if (!product) throw new AppError("Barang tidak ditemukan.", 404);
  if (!product.active) throw new AppError("Barang berstatus nonaktif.");
  validateDimensionsStandard(d, normalized, String(product.code).startsWith("IMP/"));
  const cleanLocation = String(location || "").trim();
  if (cleanLocation) resolveLocation(d, cleanLocation);
  const reasonValue = cleanReason(reason || "Barang temuan");
  const cleanNote = String(note || "").trim();
  if (cleanNote.length > 300) throw new AppError("Catatan maksimal 300 karakter.");
  const session = draftLock(d, opnameId);
  const cutoff = String(session.period_end).slice(0, 10);
  const exists = d.where("stock_opname_items", (row) => Number(row.opname_id) === Number(opnameId)
    && Number(row.product_id) === Number(productId) && normalizeSize(row.trx_size) === normalized
    && (row.location || "") === cleanLocation);
  if (exists) throw new AppError("Barang, ukuran, dan lokasi ini sudah ada. Isi stok fisik pada baris tersebut.");
  const system = stockMap(d, cutoff).get(`${Number(productId)}|${normalized}|${cleanLocation}`) || 0;
  const itemId = d.allocate("stock_opname_items");
  d.insert("stock_opname_items", {
    id: itemId, opname_id: Number(opnameId), product_id: Number(productId),
    trx_size: normalized, system_qty: system, physical_qty: physicalValue,
    location: cleanLocation, note: cleanNote, reason: reasonValue,
  });
  log(d, userId, "OPNAME_TEMUAN",
    `#${opnameId} | item=${itemId} | ${product.code} | ${sizeDisplay(normalized)} | `
    + `lokasi=${cleanLocation || "-"} | fisik=${fmtQty(physicalValue)}`,
    "stock_opname", Number(opnameId));
  return { id: itemId };
}

export function fillUncountedAsSystem(d, userId, opnameId) {
  draftLock(d, opnameId);
  let filled = 0;
  for (const item of d.filter("stock_opname_items", (row) => Number(row.opname_id) === Number(opnameId))) {
    if (item.physical_qty !== null && item.physical_qty !== undefined) continue;
    if (Number(item.system_qty) < 0) continue;
    d.update("stock_opname_items", Number(item.id), {
      physical_qty: Number(item.system_qty),
      note: String(item.note || "").trim() ? item.note : "Tidak dihitung; dianggap sesuai stok sistem.",
    });
    filled += 1;
  }
  log(d, userId, "OPNAME_ISI_SESUAI", `#${opnameId} | baris=${filled}`, "stock_opname", Number(opnameId));
  return { filled };
}

export function summarize(d, opnameId) {
  const summary = {
    items: 0, counted: 0, uncounted: 0, variance_items: 0,
    plus_qty: 0, minus_qty: 0, plus_m3: 0, minus_m3: 0,
    missing_reason: 0, missing_note: 0,
  };
  for (const item of loadItems(d, opnameId)) {
    summary.items += 1;
    if (item.physical_qty === null || item.physical_qty === undefined) {
      summary.uncounted += 1;
      continue;
    }
    summary.counted += 1;
    const diff = Number(item.physical_qty) - Number(item.system_qty || 0);
    if (Math.abs(diff) < EPS) continue;
    summary.variance_items += 1;
    const volume = m3Value(item.trx_size, Math.abs(diff));
    if (diff > 0) {
      summary.plus_qty += diff;
      summary.plus_m3 += volume;
    } else {
      summary.minus_qty += -diff;
      summary.minus_m3 += volume;
    }
    if (!String(item.reason || "").trim()) summary.missing_reason += 1;
    else if (item.reason === OPNAME_REASON_OTHER && !String(item.note || "").trim()) summary.missing_note += 1;
  }
  for (const key of ["plus_qty", "minus_qty", "plus_m3", "minus_m3"]) {
    summary[key] = pyRound(summary[key], 6);
  }
  return summary;
}

export function approvalProblems(d, opnameId) {
  const problems = [];
  const items = loadItems(d, opnameId);
  const uncounted = items.filter((item) => item.physical_qty === null || item.physical_qty === undefined);
  if (uncounted.length) {
    problems.push(
      `${uncounted.length} item belum dihitung. Hitung semua item, atau konfirmasi `
      + "\"anggap sesuai stok sistem\".",
    );
  }
  const noReason = [];
  const noNote = [];
  for (const item of items) {
    if (item.physical_qty === null || item.physical_qty === undefined) continue;
    const diff = Number(item.physical_qty) - Number(item.system_qty || 0);
    if (Math.abs(diff) < EPS) continue;
    const label = `${item.code} ${item.size_display} @${item.location || "-"}`.trim();
    if (!String(item.reason || "").trim()) noReason.push(label);
    else if (item.reason === OPNAME_REASON_OTHER && !String(item.note || "").trim()) noNote.push(label);
  }
  if (noReason.length) {
    problems.push(`${noReason.length} item selisih belum diberi alasan (contoh: ${noReason.slice(0, 3).join(", ")}).`);
  }
  if (noNote.length) {
    problems.push(`${noNote.length} item beralasan \"Lainnya\" wajib diberi catatan (contoh: ${noNote.slice(0, 3).join(", ")}).`);
  }
  return problems;
}

function postAdjustment(d, sessionId, item, diff, cutoff, reasonText, userId, stamp) {
  const number = `OPN-${sessionId}`;
  const size = normalizeSize(item.trx_size);
  const location = String(item.location || "").trim();
  const insertTrx = (qty, kind, sourceId) => {
    const id = d.allocate("transactions");
    d.insert("transactions", {
      id,
      trx_date: cutoff, product_id: Number(item.product_id), trx_type: kind, qty,
      price: 0, note: reasonText, trx_size: size, trx_number: number, supplier: "",
      location, user_id: userId ? Number(userId) : null, created_at: stamp,
      source_trx_id: sourceId ?? null, delivery_number: null, rit_id: null, seller_id: null,
    });
  };
  if (diff > 0) {
    insertTrx(diff, "MASUK", null);
    return;
  }
  const lots = d.filter("transactions", (row) => row.trx_type === "MASUK"
    && Number(row.product_id) === Number(item.product_id)
    && sqlSize(row.trx_size) === size
    && String(row.trx_date).slice(0, 10) <= cutoff)
    .slice()
    .sort((a, b) => (a.trx_date < b.trx_date ? -1 : a.trx_date > b.trx_date ? 1 : Number(a.id) - Number(b.id)))
    .map((row) => ({
      id: Number(row.id),
      rem: Number(row.qty || 0) - d.filter("transactions", (o) => Number(o.source_trx_id) === Number(row.id) && o.trx_type === "KELUAR")
        .reduce((acc, o) => acc + Number(o.qty || 0), 0),
      loc: sqlLoc(row.location),
    }))
    .filter((lot) => lot.rem > EPS);
  const sources = new Set(
    d.filter("location_transfers", (row) => Number(row.product_id) === Number(item.product_id)
      && sqlSize(row.trx_size) === size
      && sqlLoc(row.to_location) === location
      && String(row.transfer_date).slice(0, 10) <= cutoff)
      .map((row) => sqlLoc(row.from_location)),
  );
  lots.sort((a, b) => {
    const rankA = a.loc === location ? 0 : (sources.has(a.loc) ? 1 : 2);
    const rankB = b.loc === location ? 0 : (sources.has(b.loc) ? 1 : 2);
    return rankA - rankB;
  });
  let left = Number(-diff);
  for (const lot of lots) {
    if (left <= EPS) break;
    const take = Math.min(left, Number(lot.rem));
    insertTrx(take, "KELUAR", lot.id);
    left -= take;
  }
  if (left > EPS) insertTrx(left, "KELUAR", null);
}

export function approve(d, userId, opnameId) {
  const stamp = d.now;
  const session = d.one("stock_opname", Number(opnameId));
  if (!session) throw new AppError("Sesi opname tidak ditemukan.", 404);
  if (session.status === "DONE") throw new AppError("Opname ini sudah disahkan.");
  const cutoff = String(session.period_end).slice(0, 10);
  if (cutoff > todayISO()) throw new AppError("Tanggal cut-off belum tiba.");
  refreshItemsLocked(d, session);
  const problems = approvalProblems(d, opnameId);
  if (problems.length) throw new AppError(problems.join("\n"));
  const items = d.filter("stock_opname_items", (row) => Number(row.opname_id) === Number(opnameId))
    .slice()
    .sort((a, b) => (Number(a.product_id) - Number(b.product_id))
      || (a.trx_size < b.trx_size ? -1 : a.trx_size > b.trx_size ? 1 : 0)
      || (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  const snapshot = stockMap(d, cutoff);
  const current = stockMap(d);
  const codes = new Map(d.all("products").map((row) => [Number(row.id), row.code]));
  const negatives = [];
  for (const item of items) {
    const key = `${Number(item.product_id)}|${normalizeSize(item.trx_size)}|${item.location || ""}`;
    const diff = Number(item.physical_qty) - (snapshot.get(key) || 0);
    if (diff < -EPS && (current.get(key) || 0) + diff < -EPS) {
      negatives.push(
        `${codes.get(Number(item.product_id)) ?? item.product_id} `
        + `${sizeDisplay(item.trx_size)} @ ${item.location || "-"} `
        + `(stok sekarang ${qtyText(current.get(key) || 0)}, koreksi -${qtyText(-diff)})`,
      );
    }
  }
  if (negatives.length) {
    throw new AppError(
      "Penyesuaian akan membuat stok sekarang minus karena sudah ada pengeluaran setelah cut-off:\n- "
      + negatives.slice(0, 8).join("\n- ")
      + "\n\nPeriksa transaksi setelah tanggal cut-off, lalu coba lagi.",
    );
  }
  let adjust = 0;
  let plus = 0;
  let minus = 0;
  for (const item of items) {
    const key = `${Number(item.product_id)}|${normalizeSize(item.trx_size)}|${item.location || ""}`;
    const systemQty = snapshot.get(key) || 0;
    const physical = Number(item.physical_qty);
    const diff = physical - systemQty;
    d.update("stock_opname_items", Number(item.id), { system_qty: systemQty });
    if (Math.abs(diff) < EPS) continue;
    let reasonText = `Penyesuaian stok opname #${opnameId}: ${item.reason || "-"}`;
    if (String(item.note || "").trim()) reasonText += ` — ${String(item.note).trim()}`;
    postAdjustment(d, Number(opnameId), item, diff, cutoff, reasonText, userId, stamp);
    adjust += 1;
    if (diff > 0) plus += diff;
    else minus += -diff;
  }
  const after = stockMap(d, cutoff);
  for (const item of items) {
    const key = `${Number(item.product_id)}|${normalizeSize(item.trx_size)}|${item.location || ""}`;
    if (Math.abs((after.get(key) || 0) - Number(item.physical_qty)) > 1e-6) {
      throw new AppError(
        "Pemeriksaan akhir gagal: saldo setelah penyesuaian tidak sama dengan hitungan fisik. "
        + "Tidak ada data yang diubah.",
      );
    }
  }
  d.update("stock_opname", Number(opnameId), {
    status: "DONE", completed_at: stamp, approved_by: userId ? Number(userId) : null,
  });
  log(d, userId, "OPNAME_SAH",
    `#${opnameId} | cut-off=${cutoff} | penyesuaian=${adjust} | lebih=${qtyText(plus)} | kurang=${qtyText(minus)}`,
    "stock_opname", Number(opnameId));
  return { adjustments: adjust, plus, minus, cutoff };
}

export function reopen(d, userId, opnameId, reason) {
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length < 5) throw new AppError("Tulis alasan membuka kembali (minimal 5 karakter).");
  const number = `OPN-${opnameId}`;
  const session = d.one("stock_opname", Number(opnameId));
  if (!session) throw new AppError("Sesi opname tidak ditemukan.", 404);
  if (session.status !== "DONE") throw new AppError("Opname belum disahkan.");
  const end = String(session.period_end || "").slice(0, 10);
  const later = d.where("stock_opname", (row) => Number(row.id) !== Number(opnameId)
    && (String(row.period_end || "") > end
      || (String(row.period_end || "") === end && Number(row.id) > Number(opnameId))));
  if (later) {
    throw new AppError("Hanya periode terakhir yang dapat dibuka kembali. Selesaikan periode yang lebih baru terlebih dahulu.");
  }
  const adjustmentTrx = d.filter("transactions", (row) => row.trx_number === number);
  const masukIds = new Set(adjustmentTrx.filter((row) => row.trx_type === "MASUK").map((row) => Number(row.id)));
  const used = d.filter("transactions", (row) => row.trx_type === "KELUAR" && row.trx_number !== number
    && masukIds.has(Number(row.source_trx_id))).length;
  if (used > 0) {
    throw new AppError("Stok hasil penyesuaian opname ini sudah dipakai barang keluar, sehingga tidak dapat dibatalkan.");
  }
  const closure = d.where("stock_period_closures", (row) => Number(row.opname_id) === Number(opnameId));
  if (closure) {
    for (const item of d.filter("stock_period_closure_items", (row) => Number(row.closure_id) === Number(closure.id))) {
      d.delete("stock_period_closure_items", Number(item.id));
    }
    d.delete("stock_period_closures", Number(closure.id));
  }
  let deleted = 0;
  for (const row of adjustmentTrx) {
    d.delete("transactions", Number(row.id));
    deleted += 1;
  }
  const after = stockMap(d);
  for (const row of adjustmentTrx) {
    const key = `${Number(row.product_id)}|${normalizeSize(row.trx_size)}|${(row.location || "").trim()}`;
    if ((after.get(key) || 0) < -EPS) {
      throw new AppError("Membatalkan penyesuaian akan membuat stok sekarang minus. Periksa transaksi setelah cut-off.");
    }
  }
  d.update("stock_opname", Number(opnameId), {
    status: "DRAFT", completed_at: null, approved_by: null,
  });
  log(d, userId, "OPNAME_BUKA_KEMBALI",
    `#${opnameId} | ditutup=${closure ? "ya" : "tidak"} | penyesuaian dihapus=${deleted} | alasan=${cleanReason}`,
    "stock_opname", Number(opnameId));
  return { deleted };
}

function movements(d, start, end) {
  const out = new Map();
  const keyOf = (productId, size, location) => `${Number(productId)}|${size || ""}|${location || ""}`;
  const slot = (productId, size, location) => {
    const key = keyOf(productId, size, location);
    if (!out.has(key)) out.set(key, { in: 0, out: 0, transfer: 0, adj: 0 });
    return out.get(key);
  };
  for (const row of d.all("transactions")) {
    const day = String(row.trx_date).slice(0, 10);
    if (day < start || day > end) continue;
    const isOpn = String(row.trx_number || "").startsWith("OPN-");
    const slotRow = slot(row.product_id, sqlSize(row.trx_size), sqlLoc(row.location));
    const qty = Number(row.qty || 0);
    if (row.trx_type === "MASUK") {
      if (!isOpn) slotRow.in += qty;
      if (isOpn) slotRow.adj += qty;
    } else {
      if (!isOpn) slotRow.out += qty;
      if (isOpn) slotRow.adj -= qty;
    }
  }
  for (const row of d.all("location_transfers")) {
    const day = String(row.transfer_date).slice(0, 10);
    if (day < start || day > end) continue;
    const qty = Number(row.qty || 0);
    slot(row.product_id, sqlSize(row.trx_size), sqlLoc(row.from_location)).transfer -= qty;
    slot(row.product_id, sqlSize(row.trx_size), sqlLoc(row.to_location)).transfer += qty;
  }
  return out;
}

export function rollforward(d, start, end) {
  const startDate = parseISODate(start);
  const endDate = parseISODate(end);
  const opening = stockMap(d, addDaysParts(start, -1));
  const closing = stockMap(d, end);
  const moves = movements(d, start, end);
  const keys = new Set([...opening.keys(), ...closing.keys(), ...moves.keys()]);
  const rows = [];
  for (const key of keys) {
    const move = moves.get(key) || { in: 0, out: 0, transfer: 0, adj: 0 };
    const openingQty = opening.get(key) || 0;
    const closingQty = closing.get(key) || 0;
    if ([openingQty, closingQty, move.in, move.out, move.transfer, move.adj].every((value) => Math.abs(value) < 1e-6)) {
      continue;
    }
    rows.push({
      key, opening: openingQty, in: move.in, out: move.out,
      transfer: move.transfer, adj: move.adj, closing: closingQty,
      gap: openingQty + move.in - move.out + move.transfer + move.adj - closingQty,
    });
  }
  rows.sort((a, b) => {
    const [p1, s1, l1] = a.key.split("|");
    const [p2, s2, l2] = b.key.split("|");
    return (Number(p1) - Number(p2))
      || (s1 < s2 ? -1 : s1 > s2 ? 1 : 0)
      || (l1 < l2 ? -1 : l1 > l2 ? 1 : 0);
  });
  return rows;
}

export function closePeriod(d, userId, opnameId) {
  const stamp = d.now;
  const session = d.one("stock_opname", Number(opnameId));
  if (!session) throw new AppError("Sesi opname tidak ditemukan.", 404);
  if (session.status !== "DONE") throw new AppError("Sahkan opname terlebih dahulu sebelum menutup periode.");
  if (d.where("stock_period_closures", (row) => Number(row.opname_id) === Number(opnameId))) {
    throw new AppError("Periode ini sudah ditutup.");
  }
  const items = d.filter("stock_opname_items", (row) => Number(row.opname_id) === Number(opnameId))
    .slice()
    .sort((a, b) => (Number(a.product_id) - Number(b.product_id))
      || (a.trx_size < b.trx_size ? -1 : a.trx_size > b.trx_size ? 1 : 0)
      || (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  if (items.some((item) => item.physical_qty === null || item.physical_qty === undefined)) {
    throw new AppError("Ada item yang belum dihitung; buka kembali pengesahan dan lengkapi hitungan.");
  }
  const cutoff = String(session.period_end).slice(0, 10);
  const start = String(session.period_start || cutoff).slice(0, 10);
  const last = lastClosure(d);
  if (last && last.period_end) {
    if (cutoff <= String(last.period_end).slice(0, 10)) {
      throw new AppError("Periode ini berakhir sebelum/pada penutupan terakhir.");
    }
    if (start !== addDaysParts(String(last.period_end).slice(0, 10), 1)) {
      throw new AppError("Awal periode tidak bersambung dengan penutupan terakhir; ada celah antar periode.");
    }
  }
  const snapshot = stockMap(d, cutoff);
  for (const item of items) {
    const key = `${Number(item.product_id)}|${normalizeSize(item.trx_size)}|${item.location || ""}`;
    if (Math.abs((snapshot.get(key) || 0) - Number(item.physical_qty)) > 1e-6) {
      throw new AppError(
        "Saldo buku per cut-off berbeda dari hitungan fisik (ada transaksi yang berubah setelah pengesahan). "
        + "Buka kembali pengesahan, lalu sahkan ulang.",
      );
    }
  }
  const rows = rollforward(d, start, cutoff);
  const bad = rows.filter((row) => Math.abs(row.gap) > 1e-6);
  if (bad.length) throw new AppError(`Rincian saldo tidak seimbang pada ${bad.length} baris (periksa tanggal transaksi).`);
  const closureId = d.allocate("stock_period_closures");
  d.insert("stock_period_closures", {
    id: closureId, opname_id: Number(opnameId), period_start: start, period_end: cutoff,
    closed_at: stamp, user_id: userId ? Number(userId) : null, item_count: rows.length,
    note: "Saldo akhir buku setelah penyesuaian opname.",
  });
  for (const row of rows) {
    const [productId, size, location] = row.key.split("|");
    const itemId = d.allocate("stock_period_closure_items");
    d.insert("stock_period_closure_items", {
      id: itemId, closure_id: closureId, product_id: Number(productId), trx_size: size,
      location: location || "", closing_qty: row.closing, opening_qty: row.opening,
      in_qty: row.in, out_qty: row.out, transfer_qty: row.transfer, adj_qty: row.adj,
    });
  }
  log(d, userId, "OPNAME_TUTUP", `#${opnameId} | ${start} s.d. ${cutoff} | saldo=${rows.length}`, "stock_opname", Number(opnameId));
  return { closure_id: closureId, items: rows.length, start, end: cutoff };
}

export function cancelDraft(d, userId, opnameId) {
  const session = draftLock(d, opnameId);
  for (const item of d.filter("stock_opname_items", (row) => Number(row.opname_id) === Number(opnameId))) {
    d.delete("stock_opname_items", Number(item.id));
  }
  d.delete("stock_opname", Number(opnameId));
  log(d, userId, "OPNAME_BATAL",
    `#${opnameId} | ${session.period_start} s.d. ${session.period_end}`,
    "stock_opname", Number(opnameId));
  return { cancelled: true };
}

export function getSession(d, opnameId) {
  const session = d.one("stock_opname", Number(opnameId));
  if (!session) throw new AppError("Sesi opname tidak ditemukan.", 404);
  const closure = d.where("stock_period_closures", (row) => Number(row.opname_id) === Number(opnameId));
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  const result = {
    ...session,
    closure_id: closure?.id ?? null,
    closed_at: closure?.closed_at ?? null,
    created_by_name: users.get(Number(session.user_id))?.username ?? null,
    approved_by_name: users.get(Number(session.approved_by))?.username ?? null,
  };
  result.label_status = sessionStatus(result);
  result.period_start_display = fmtDateValue(result.period_start);
  result.period_end_display = fmtDateValue(result.period_end);
  result.items = loadItems(d, opnameId);
  result.summary = summarize(d, opnameId);
  result.problems = result.status === "DRAFT" ? approvalProblems(d, opnameId) : [];
  result.locked_through = lockedThrough(d);
  let closurePayload = null;
  if (result.closure_id) {
    closurePayload = { ...d.one("stock_period_closures", Number(result.closure_id)) };
    closurePayload.rows = d.filter("stock_period_closure_items", (row) => Number(row.closure_id) === Number(result.closure_id))
      .map((row) => {
        const product = d.one("products", Number(row.product_id)) || {};
        return { ...row, code: product.code, name: product.name, unit: product.unit, size_display: sizeDisplay(row.trx_size) };
      })
      .sort((a, b) => nocase(a.name, b.name)
        || (a.trx_size < b.trx_size ? -1 : a.trx_size > b.trx_size ? 1 : 0)
        || (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  }
  result.closure = closurePayload;
  result.next = result.label_status === "DITUTUP" ? nextPeriodInfo(d) : null;
  return result;
}

/* ------------------------------------------------------------- laporan */

function currentBounds() {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [`${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`, todayISO()];
}

export function resolveBounds(start, end) {
  const [defaultStart, defaultEnd] = currentBounds();
  const from = String(start || "").trim() ? isoDate(start, "Tanggal dari") : defaultStart;
  const to = String(end || "").trim() ? isoDate(end, "Tanggal sampai") : defaultEnd;
  if (from > to) throw new AppError("Tanggal dari tidak boleh melewati tanggal sampai.");
  return [from, to];
}

function bookingPrice(d) {
  const reference = priceReference(d);
  const fallback = new Map(d.all("products").map((row) => [Number(row.id), Number(row.purchase_price || 0)]));
  return [reference, fallback];
}

function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1].slice(0, 3)} ${String(year).slice(2)}`;
}

function shiftMonth(year, month, delta) {
  const index = year * 12 + (month - 1) + delta;
  return [Math.floor(index / 12), (index % 12) + 1];
}

function series(d, months = 6) {
  const today = new Date();
  const points = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const [year, month] = shiftMonth(today.getFullYear(), today.getMonth() + 1, -offset);
    const lastDay = new Date(year, month, 0).getDate();
    const pad = (n) => String(n).padStart(2, "0");
    points.push({
      month: `${year}-${pad(month)}`,
      label: monthLabel(year, month),
      start: `${year}-${pad(month)}-01`,
      end: `${year}-${pad(month)}-${pad(lastDay)}`,
      incoming_qty: 0, incoming_m3: 0, incoming_amount: 0,
      outgoing_qty: 0, outgoing_m3: 0,
    });
  }
  if (!points.length) return [];
  const first = points[0].start;
  const lookup = new Map(points.map((point) => [point.month, point]));
  for (const row of d.all("transactions")) {
    const day = String(row.trx_date).slice(0, 10);
    if (day < first || day > todayISO()) continue;
    const point = lookup.get(String(row.trx_date).slice(0, 7));
    if (!point || String(row.trx_number || "").startsWith("OPN-")) continue;
    const volume = m3Value(row.trx_size, row.qty);
    if (row.trx_type === "MASUK") {
      point.incoming_qty += Number(row.qty || 0);
      point.incoming_m3 += volume;
      point.incoming_amount += volume * Number(row.price || 0);
    } else {
      point.outgoing_qty += Number(row.qty || 0);
      point.outgoing_m3 += volume;
    }
  }
  for (const point of points) {
    point.incoming_qty = pyRound(point.incoming_qty, 4);
    point.outgoing_qty = pyRound(point.outgoing_qty, 4);
    point.incoming_m3 = pyRound(point.incoming_m3, 6);
    point.outgoing_m3 = pyRound(point.outgoing_m3, 6);
    point.incoming_amount = pyRound(point.incoming_amount, 6);
  }
  return points;
}

export function dashboard(d) {
  const today = todayISO();
  const [monthStart] = currentBounds();
  const grouped = stockGrouped(d);
  const totalQty = pyRound(grouped.reduce((acc, row) => acc + Number(row.stock || 0), 0), 4);
  const totalM3 = pyRound(grouped.reduce((acc, row) => acc + Number(row.m3 || 0), 0), 6);
  const [reference, fallback] = bookingPrice(d);
  let stockValue = 0;
  for (const row of grouped) {
    const price = reference.get(`${Number(row.product_id)}|${row.size}`) ?? fallback.get(Number(row.product_id)) ?? 0;
    stockValue += Number(row.m3 || 0) * Number(price);
  }
  let todayInQty = 0;
  let todayOutQty = 0;
  let monthInQty = 0;
  let monthOutQty = 0;
  let monthInM3 = 0;
  let monthInAmount = 0;
  let monthOutM3 = 0;
  let todayInM3 = 0;
  let todayOutM3 = 0;
  for (const row of d.all("transactions")) {
    const day = String(row.trx_date).slice(0, 10);
    if (day < monthStart) continue;
    const isOpn = String(row.trx_number || "").startsWith("OPN-");
    if (isOpn) continue;
    const qty = Number(row.qty || 0);
    const volume = m3Value(row.trx_size, row.qty);
    if (row.trx_type === "MASUK") {
      monthInQty += qty;
      monthInM3 += volume;
      monthInAmount += volume * Number(row.price || 0);
      if (day === today) {
        todayInQty += qty;
        todayInM3 += volume;
      }
    } else {
      monthOutQty += qty;
      monthOutM3 += volume;
      if (day === today) {
        todayOutQty += qty;
        todayOutM3 += volume;
      }
    }
  }
  const openPeriod = nextPeriodInfo(d);
  const unclosed = openPeriod.unclosed;
  let unclosedPayload = null;
  if (unclosed) {
    const summary = summarize(d, Number(unclosed.id));
    unclosedPayload = {
      id: Number(unclosed.id),
      period_start_display: displayDate(String(unclosed.period_start).slice(0, 10)),
      period_end_display: displayDate(String(unclosed.period_end).slice(0, 10)),
      status: sessionStatus({ ...unclosed, closure_id: d.where("stock_period_closures", (row) => Number(row.opname_id) === Number(unclosed.id))?.id ?? null }),
      summary,
    };
  }
  const activeTallies = d.filter("tally_headers", (row) => row.status === "POSTED").length;
  const activeRecaps = d.filter("payment_recap_headers", (row) => row.status === "AKTIF").length;
  const counts = {
    products: d.filter("products", (row) => row.active === 1 || row.active === true).length,
    sellers: d.filter("sellers", (row) => row.active === 1 || row.active === true).length,
    locations: d.filter("storage_locations", (row) => row.active === 1 || row.active === true).length,
    tallies: activeTallies,
    recaps: activeRecaps,
    users: d.filter("users", (row) => row.active === 1 || row.active === true).length,
  };
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  const recent = d.all("activity_log")
    .slice()
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 8)
    .map((row) => ({
      id: row.id, event_time: row.event_time, action: row.action, detail: row.detail,
      username: users.get(Number(row.user_id))?.username ?? "sistem",
      time_display: String(row.event_time || "").slice(0, 16).replace("T", " "),
    }));
  const locations = [];
  const buckets = new Map();
  for (const row of stockRows(d)) {
    const location = row.location || "Tanpa lokasi";
    if (!buckets.has(location)) buckets.set(location, { location, qty: 0, m3: 0, items: 0 });
    const bucket = buckets.get(location);
    bucket.qty += Number(row.stock || 0);
    bucket.m3 += Number(row.m3 || 0);
    bucket.items += 1;
  }
  for (const bucket of [...buckets.values()].sort((a, b) => b.m3 - a.m3)) {
    bucket.qty = pyRound(bucket.qty, 4);
    bucket.m3 = pyRound(bucket.m3, 6);
    locations.push(bucket);
  }
  const topProducts = grouped.slice().sort((a, b) => b.m3 - a.m3).slice(0, 6);
  for (const row of topProducts) {
    row.locations_count = row.location_count ?? Object.keys(row.locations || {}).length;
  }
  return {
    today,
    today_display: displayDate(today),
    locked_through: lockedThrough(d),
    stock: { qty: totalQty, m3: totalM3, value: pyRound(stockValue, 2), rows: grouped.length },
    today_in: { qty: pyRound(todayInQty, 4), m3: pyRound(todayInM3, 6) },
    today_out: { qty: pyRound(todayOutQty, 4), m3: pyRound(todayOutM3, 6) },
    month_in: { qty: pyRound(monthInQty, 4), m3: pyRound(monthInM3, 6), amount: pyRound(monthInAmount, 2) },
    month_out: { qty: pyRound(monthOutQty, 4), m3: pyRound(monthOutM3, 6) },
    counts,
    period: openPeriod,
    unclosed: unclosedPayload,
    series: series(d, 6),
    top_products: topProducts,
    locations,
    recent_activity: recent,
  };
}

export function transactionReport(d, start = "", end = "", kind = "MASUK", sellerId = null,
  productId = null, location = "", query = "") {
  const [from, to] = resolveBounds(start, end);
  const cleanKind = String(kind || "MASUK").toUpperCase();
  let rows = d.filter("transactions", (row) => row.trx_date >= from && row.trx_date <= to);
  if (cleanKind === "MASUK" || cleanKind === "KELUAR") {
    rows = rows.filter((row) => row.trx_type === cleanKind && !String(row.trx_number || "").startsWith("OPN-"));
  } else if (cleanKind === "OPNAME") {
    rows = rows.filter((row) => String(row.trx_number || "").startsWith("OPN-"));
  } else if (cleanKind !== "SEMUA") {
    throw new AppError("Jenis laporan transaksi tidak dikenal.");
  } else {
    rows = rows.filter((row) => !String(row.trx_number || "").startsWith("OPN-"));
  }
  if (sellerId !== null && sellerId !== undefined && sellerId !== "") {
    rows = rows.filter((row) => Number(row.seller_id) === Number(sellerId));
  }
  if (productId !== null && productId !== undefined && productId !== "") {
    rows = rows.filter((row) => Number(row.product_id) === Number(productId));
  }
  const termLoc = String(location || "").trim();
  if (termLoc) rows = rows.filter((row) => row.location === termLoc);
  const term = String(query || "").trim();
  if (term) {
    rows = rows.filter((row) => {
      const product = d.one("products", Number(row.product_id)) || {};
      const seller = row.seller_id ? d.one("sellers", Number(row.seller_id)) : null;
      return likeReport(term, product.code, product.name, row.trx_size, row.trx_number, row.delivery_number, row.note, seller?.name);
    });
  }
  rows = rows.slice().sort((a, b) => (a.trx_date < b.trx_date ? -1 : a.trx_date > b.trx_date ? 1 : Number(a.id) - Number(b.id)));
  let totalQty = 0;
  let totalM3 = 0;
  let totalAmount = 0;
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  const rits = new Map(d.all("seller_rits").map((row) => [Number(row.id), row]));
  const sources = new Map(d.all("transactions").map((row) => [Number(row.id), row]));
  const decorated = rows.map((row) => {
    const product = d.one("products", Number(row.product_id)) || {};
    const seller = row.seller_id ? d.one("sellers", Number(row.seller_id)) : null;
    const rit = row.rit_id ? rits.get(Number(row.rit_id)) : null;
    const user = row.user_id ? users.get(Number(row.user_id)) : null;
    const source = row.source_trx_id ? sources.get(Number(row.source_trx_id)) : null;
    const volume = m3Value(row.trx_size, row.qty);
    const amount = volume * Number(row.price || 0);
    const size = normalizeSize(row.trx_size);
    totalQty += Number(row.qty || 0);
    totalM3 += volume;
    totalAmount += amount;
    return {
      id: row.id, trx_date: row.trx_date, trx_type: row.trx_type, qty: row.qty,
      price: row.price, note: row.note, trx_size: row.trx_size, location: row.location,
      trx_number: row.trx_number, delivery_number: row.delivery_number, supplier: row.supplier,
      created_at: row.created_at,
      code: product.code, name: product.name, unit: product.unit,
      seller_name: seller?.name ?? null,
      rit_number: rit?.rit_number ?? null, rit_date: rit?.rit_date ?? null,
      username: user?.username ?? null,
      source_number: source?.trx_number ?? null,
      size, size_display: sizeDisplay(size),
      qty_display: fmtQty(row.qty),
      m3: pyRound(volume, 6),
      amount: pyRound(amount, 2),
      date_display: displayDate(String(row.trx_date).slice(0, 10)),
      reference: row.trx_number || row.delivery_number || "-",
      rit_number_display: rit ? pad2(rit.rit_number) : "-",
    };
  });
  for (const row of decorated) {
    row.seller_name = row.seller_name ?? "-";
  }
  return {
    start: from, end: to, kind: cleanKind,
    start_display: displayDate(from), end_display: displayDate(to),
    rows: decorated,
    totals: {
      count: decorated.length, qty: pyRound(totalQty, 4),
      m3: pyRound(totalM3, 6), amount: pyRound(totalAmount, 2),
    },
  };
}

function likeReport(term, ...fields) {
  const needle = String(term || "").toLowerCase();
  return fields.some((field) => String(field ?? "").toLowerCase().includes(needle));
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stockReport(d, cutoff = "", query = "", location = "", thickness = "") {
  const cut = String(cutoff || "").trim() ? isoDate(cutoff, "Tanggal cut-off") : "";
  const rows = stockRows(d, cut || null);
  const [reference, fallback] = bookingPrice(d);
  const term = String(query || "").trim().toLowerCase();
  const loc = String(location || "").trim();
  let thick = null;
  if (String(thickness || "").trim()) {
    const parsed = Number(String(thickness).replace(",", "."));
    thick = Number.isFinite(parsed) ? parsed : null;
  }
  const result = [];
  for (const row of rows) {
    if (term && !`${row.code} ${row.name} ${row.size_display} ${row.location}`.toLowerCase().includes(term)) continue;
    if (loc && String(row.location) !== loc) continue;
    const [, tval] = sizeParts(row.size);
    if (thick !== null && Math.abs(tval - thick) > 0.0001) continue;
    const price = reference.get(`${Number(row.product_id)}|${row.size}`) ?? fallback.get(Number(row.product_id)) ?? 0;
    result.push({
      ...row,
      price: pyRound(Number(price), 2),
      value: pyRound(Number(row.m3 || 0) * Number(price), 2),
    });
  }
  result.sort((a, b) => cmpStr(a.name.toLowerCase(), b.name.toLowerCase())
    || cmpStr(a.size, b.size)
    || cmpStr(a.location, b.location));
  return {
    cutoff: cut, cutoff_display: cut ? displayDate(cut) : "Saat ini",
    rows: result,
    totals: {
      qty: pyRound(result.reduce((acc, r) => acc + Number(r.stock || 0), 0), 4),
      m3: pyRound(result.reduce((acc, r) => acc + Number(r.m3 || 0), 0), 6),
      value: pyRound(result.reduce((acc, r) => acc + Number(r.value || 0), 0), 2),
      lots: result.length,
    },
  };
}

export function sellerSummary(d, start = "", end = "") {
  const [from, to] = resolveBounds(start, end);
  const buckets = new Map();
  for (const row of d.all("transactions")) {
    if (row.trx_type !== "MASUK" || row.seller_id === null || row.seller_id === undefined) continue;
    const day = String(row.trx_date).slice(0, 10);
    if (day < from || day > to) continue;
    if (String(row.trx_number || "").startsWith("OPN-")) continue;
    const key = Number(row.seller_id);
    if (!buckets.has(key)) buckets.set(key, { rits: new Set(), notes: new Set(), qty: 0, lines: 0, m3: 0, amount: 0 });
    const bucket = buckets.get(key);
    if (row.rit_id !== null && row.rit_id !== undefined) bucket.rits.add(Number(row.rit_id));
    bucket.notes.add(row.trx_number || "");
    bucket.qty += Number(row.qty || 0);
    bucket.lines += 1;
    const volume = m3Value(row.trx_size, row.qty);
    bucket.m3 += volume;
    bucket.amount += volume * Number(row.price || 0);
  }
  const rows = [...buckets.entries()]
    .map(([sellerId, bucket]) => {
      const seller = d.one("sellers", sellerId);
      if (!seller) return null;
      return {
        seller_id: sellerId, seller_name: seller.name, city: seller.city,
        rits: bucket.rits.size, notes: bucket.notes.size,
        qty: pyRound(bucket.qty, 4), lines: bucket.lines,
        m3: pyRound(bucket.m3, 6), amount: pyRound(bucket.amount, 2),
      };
    })
    .filter(Boolean)
    .sort((a, b) => nocase(a.seller_name, b.seller_name));
  return {
    start: from, end: to,
    start_display: displayDate(from), end_display: displayDate(to),
    rows,
    totals: {
      sellers: rows.length,
      qty: pyRound(rows.reduce((acc, r) => acc + Number(r.qty || 0), 0), 4),
      m3: pyRound(rows.reduce((acc, r) => acc + Number(r.m3 || 0), 0), 6),
      amount: pyRound(rows.reduce((acc, r) => acc + Number(r.amount || 0), 0), 2),
    },
  };
}

export function recapReport(d, start = "", end = "", sellerId = null) {
  const [from, to] = resolveBounds(start, end);
  const rows = listRecaps(d, sellerId, from, to);
  let total = 0;
  for (const row of rows) {
    row.created_display = displayDate(String(row.created_at || "").slice(0, 10));
    total += Number(row.total_amount || 0);
  }
  return {
    start: from, end: to,
    start_display: displayDate(from), end_display: displayDate(to),
    rows,
    totals: { count: rows.length, amount: pyRound(total, 2) },
  };
}

export function tallyReport(d, start = "", end = "", sellerId = null) {
  const [from, to] = resolveBounds(start, end);
  const rows = listTallies(d, sellerId, from, to);
  return {
    start: from, end: to,
    start_display: displayDate(from), end_display: displayDate(to),
    rows,
    totals: {
      count: rows.length,
      amount: pyRound(rows.reduce((acc, r) => acc + Number(r.total_amount || 0), 0), 2),
      volume: pyRound(rows.reduce((acc, r) => acc + Number(r.total_volume || 0), 0), 6),
    },
  };
}

export function transferReport(d, start = "", end = "", query = "") {
  const [from, to] = resolveBounds(start, end);
  const rows = listTransfers(d, from, to, query);
  return {
    start: from, end: to,
    start_display: displayDate(from), end_display: displayDate(to),
    rows,
    totals: {
      count: rows.length,
      qty: pyRound(rows.reduce((acc, r) => acc + Number(r.qty || 0), 0), 4),
      m3: pyRound(rows.reduce((acc, r) => acc + Number(r.m3 || 0), 0), 6),
    },
  };
}

export function activityReport(d, start = "", end = "", userId = null, query = "", limit = 500) {
  const [from, to] = resolveBounds(start, end);
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  let rows = d.filter("activity_log", (row) => {
    const day = String(row.event_time).slice(0, 10);
    return day >= from && day <= to;
  });
  if (userId !== null && userId !== undefined && userId !== "") {
    rows = rows.filter((row) => Number(row.user_id) === Number(userId));
  }
  const term = String(query || "").trim();
  if (term) {
    rows = rows.filter((row) => {
      const username = users.get(Number(row.user_id))?.username ?? "";
      return likeReport(term, row.action, row.detail, username);
    });
  }
  rows = rows.slice().sort((a, b) => Number(b.id) - Number(a.id)).slice(0, Math.max(1, Math.min(Number(limit || 500), 2000)));
  return {
    start: from, end: to,
    start_display: displayDate(from), end_display: displayDate(to),
    rows: rows.map((row) => ({
      id: row.id, event_time: row.event_time, action: row.action, detail: row.detail,
      user_id: row.user_id,
      username: users.get(Number(row.user_id))?.username ?? "sistem",
      time_display: String(row.event_time || "").slice(0, 16).replace("T", " "),
    })),
  };
}

/* --------------------------------------------------- ekspor berkas (CSV) */

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",;\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvBytes(title, subtitle, headers, rows, totals = null) {
  const lines = [];
  lines.push([`${title}`]);
  if (subtitle) lines.push([subtitle]);
  lines.push([]);
  lines.push(headers.map(csvCell));
  for (const row of rows) lines.push(row.map(csvCell));
  if (totals) lines.push(totals.map(csvCell));
  const content = lines.map((line) => line.join(";")).join("\r\n");
  return `\uFEFF${content}`;
}

export function buildExport(d, name, params = {}) {
  const cleanName = String(name || "").trim().toLowerCase();
  const stamp = todayISO().replace(/-/g, "");
  if (["transactions", "transaksi", "masuk", "keluar"].includes(cleanName)) {
    const kind = params.kind || (cleanName === "keluar" ? "KELUAR" : "MASUK");
    const data = transactionReport(d, params.start, params.end, kind, params.seller_id, params.product_id, params.location, params.query);
    const headers = ["Tanggal", "Jenis", "No. Nota/Ref", "Surat Jalan", "Penjual", "Rit", "Kode", "Barang", "Ukuran T×L×P", "Lokasi", "Qty", "M³", "Harga/m³", "Jumlah", "Catatan", "Petugas"];
    const rows = data.rows.map((row) => [
      row.date_display, row.trx_type, row.trx_number || "-", row.delivery_number || "-",
      row.seller_name, row.rit_number_display, row.code, row.name, row.size_display,
      row.location || "-", row.qty, row.m3, row.price, row.amount, row.note || "", row.username || "-",
    ]);
    const total = ["TOTAL", "", "", "", "", "", "", "", "", "", data.totals.qty, data.totals.m3, "", data.totals.amount, "", ""];
    const content = csvBytes(`Laporan Transaksi ${kind === "MASUK" ? "Masuk" : "Keluar"}`, `Periode ${data.start_display} s.d. ${data.end_display}`, headers, rows, total);
    return [`laporan-${kind.toLowerCase()}-${stamp}.csv`, content];
  }
  if (["stock", "stok"].includes(cleanName)) {
    const data = stockReport(d, params.cutoff, params.query, params.location, params.thickness);
    const headers = ["Kode", "Barang", "Ukuran T×L×P", "Lokasi", "Qty", "M³", "Harga Acuan/m³", "Nilai Persediaan"];
    const rows = data.rows.map((row) => [row.code, row.name, row.size_display, row.location || "-", row.stock, row.m3, row.price, row.value]);
    const total = ["TOTAL", "", "", "", data.totals.qty, data.totals.m3, "", data.totals.value];
    const content = csvBytes("Laporan Persediaan", `Posisi ${data.cutoff_display}`, headers, rows, total);
    return [`laporan-stok-${stamp}.csv`, content];
  }
  if (["sellers", "penjual"].includes(cleanName)) {
    const data = sellerSummary(d, params.start, params.end);
    const headers = ["Penjual", "Kota", "Jumlah Rit", "Jumlah Nota", "Baris", "Qty", "M³", "Nilai Pembelian"];
    const rows = data.rows.map((row) => [row.seller_name, row.city || "-", row.rits, row.notes, row.lines, row.qty, row.m3, row.amount]);
    const total = ["TOTAL", "", "", "", "", data.totals.qty, data.totals.m3, data.totals.amount];
    const content = csvBytes("Rekap Pembelian per Penjual", `Periode ${data.start_display} s.d. ${data.end_display}`, headers, rows, total);
    return [`rekap-penjual-${stamp}.csv`, content];
  }
  if (["recaps", "rekap"].includes(cleanName)) {
    const data = recapReport(d, params.start, params.end, params.seller_id);
    const headers = ["Nomor Rekap", "Tanggal", "Penjual", "Rit / Nota", "Qty", "M³", "Nilai", "Status"];
    const rows = data.rows.map((row) => [
      row.recap_number, row.created_display, row.seller_name || "-",
      `${row.rit_number_display || "-"} / ${row.note || "-"}`,
      row.total_qty, row.total_volume, row.total_amount, row.status || "-",
    ]);
    const total = ["TOTAL", "", "", "", "", "", data.totals.amount, ""];
    const content = csvBytes("Rekap Pembayaran", `Periode ${data.start_display} s.d. ${data.end_display}`, headers, rows, total);
    return [`rekap-pembayaran-${stamp}.csv`, content];
  }
  if (["tallies", "tally"].includes(cleanName)) {
    const data = tallyReport(d, params.start, params.end, params.seller_id);
    const headers = ["Nomor Tally", "Dibuat", "Penjual", "Rit", "Qty", "M³", "Nilai", "Pemeriksa", "Status"];
    const rows = data.rows.map((row) => [
      row.tally_number, row.created_display, row.seller_name || "-", row.rit_number_display || "-",
      row.total_qty, row.total_volume, row.total_amount, row.signature || "-", row.status || "-",
    ]);
    const total = ["TOTAL", "", "", "", "", data.totals.volume, data.totals.amount, "", ""];
    const content = csvBytes("Daftar Tally", `Periode ${data.start_display} s.d. ${data.end_display}`, headers, rows, total);
    return [`daftar-tally-${stamp}.csv`, content];
  }
  if (["transfers", "mutasi"].includes(cleanName)) {
    const data = transferReport(d, params.start, params.end, params.query);
    const headers = ["Tanggal", "Kode", "Barang", "Ukuran T×L×P", "Dari", "Ke", "Qty", "M³", "Catatan", "Petugas"];
    const rows = data.rows.map((row) => [
      displayDate(String(row.transfer_date).slice(0, 10)), row.code, row.name, row.size_display,
      row.from_location, row.to_location, row.qty, row.m3, row.note || "", row.username || "-",
    ]);
    const total = ["TOTAL", "", "", "", "", "", data.totals.qty, data.totals.m3, "", ""];
    const content = csvBytes("Mutasi Antar Lokasi", `Periode ${data.start_display} s.d. ${data.end_display}`, headers, rows, total);
    return [`mutasi-lokasi-${stamp}.csv`, content];
  }
  if (["activity", "aktivitas"].includes(cleanName)) {
    const data = activityReport(d, params.start, params.end, params.user_id, params.query);
    const headers = ["Waktu", "Pengguna", "Aksi", "Rincian"];
    const rows = data.rows.map((row) => [row.time_display, row.username, row.action, row.detail || ""]);
    const content = csvBytes("Log Aktivitas", `Periode ${data.start_display} s.d. ${data.end_display}`, headers, rows);
    return [`log-aktivitas-${stamp}.csv`, content];
  }
  if (["imports", "impor"].includes(cleanName)) {
    const data = listImports(d, params.start, params.end, params.query);
    const headers = ["Tanggal", "No. Penerimaan", "No. Dokumen", "Barcode", "Kode", "Barang", "Ukuran T×L×P", "Qty", "M³", "Harga/m³", "Jumlah", "Pemasok", "Lokasi", "Petugas"];
    const rows = data.rows.map((row) => [
      row.date_display, row.trx_number, row.delivery_number || "-", row.barcode || "-",
      row.code, row.name, row.size_display, row.qty, row.m3, row.price, row.amount,
      row.supplier || "-", row.location || "-", row.username || "-",
    ]);
    const total = ["TOTAL", "", "", "", "", "", "", data.totals.qty, data.totals.m3, "", data.totals.amount, "", "", ""];
    const content = csvBytes("Penerimaan Kayu Impor", `Periode ${data.start_display} s.d. ${data.end_display}`, headers, rows, total);
    return [`penerimaan-impor-${stamp}.csv`, content];
  }
  if (["opname", "stock-opname"].includes(cleanName)) {
    if (params.id) {
      const session = getSession(d, Number(params.id));
      const headers = ["No", "Kode", "Barang", "Ukuran T×L×P", "Lokasi", "Stok Sistem", "Stok Fisik", "Selisih", "Alasan", "Catatan"];
      const rows = (session.items || []).map((item, index) => [
        index + 1, item.code || "", item.name || "", item.size_display || "-", item.location || "-",
        Number(item.system_qty || 0),
        item.physical_qty === null || item.physical_qty === undefined ? "" : Number(item.physical_qty),
        item.diff === null || item.diff === undefined ? "" : Number(item.diff),
        item.reason || "", item.note || "",
      ]);
      const content = csvBytes("Stok Opname", `Periode ${session.period_start_display} s.d. ${session.period_end_display} · ${session.label_status}`, headers, rows);
      return [`opname-${params.id}-${stamp}.csv`, content];
    }
    const sessions = listSessions(d);
    const headers = ["No", "Periode Mulai", "Cut-off", "Status", "Item", "Dibuat Oleh", "Disahkan Oleh", "Ditutup"];
    const rows = sessions.map((row) => [
      row.id, row.period_start_display, row.period_end_display, row.label_status,
      row.item_count, row.created_by_name || "-", row.approved_by_name || "-", row.closed_display || "-",
    ]);
    const content = csvBytes("Daftar Periode Stok Opname", "", headers, rows);
    return [`daftar-opname-${stamp}.csv`, content];
  }
  if (["stock-card", "kartu-stok"].includes(cleanName)) {
    const card = stockCard(d, Number(params.product_id), params.size, params.location, params.start, params.end);
    const headers = ["Tanggal", "Jenis", "Referensi", "Masuk", "Keluar", "Saldo", "Catatan"];
    const rows = card.movements.map((row) => [
      displayDate(row.date), row.kind, row.reference, row.in_qty, row.out_qty, row.balance, row.note || "",
    ]);
    const content = csvBytes(
      `Kartu Stok ${card.product.name}`,
      `Ukuran ${card.size_display} · Lokasi ${card.location} · ${displayDate(card.start)} s.d. ${displayDate(card.end)} · Saldo awal ${fmtQty(card.opening)}`,
      headers, rows,
    );
    return [`kartu-stok-${stamp}.csv`, content];
  }
  throw new AppError("Jenis ekspor tidak dikenal.", 404);
}
