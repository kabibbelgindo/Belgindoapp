/* Port server/documents.py + server/stock.py + server/importing.py.
   Semua fungsi menerima handle `d` dari engine (baca + tulis buffer) dan
   mempertahankan nama/aturan aslinya agar mudah dibandingkan dengan server. */

import {
  AppError, EPS, displayDate, fmtQty, isoDate, m3Value,
  makeSize, normalizeSize, parseISODate, sizeDisplay,
  sizeParts, todayISO, trimNumber, pyRound, pad2, pyFloatStr, pyG,
} from "./core.js";

/* ------------------------------------------------------------------ util */

export function sqlSize(text) {
  return String(text || "").trim().replace(/×/g, "x").replace(/\s+/g, "").toLowerCase();
}

export function sqlLoc(text) {
  return String(text ?? "").trim();
}

export function nocase(a, b) {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export function likeIncludes(term, ...fields) {
  const needle = String(term || "").toLowerCase();
  return fields.some((field) => String(field ?? "").toLowerCase().includes(needle));
}

export function log(d, userId, action, detail = "", entity = "activity", entityId = null) {
  const stamp = d.now;
  const logId = d.allocate("activity_log");
  d.insert("activity_log", {
    id: logId, event_time: stamp, user_id: userId ? Number(userId) : null,
    action, detail: detail || null,
  });
  const outboxId = d.allocate("sync_outbox");
  d.insert("sync_outbox", {
    id: outboxId, created_at: stamp, entity, entity_id: entityId, action, status: "SYNCED",
    note: null,
  });
}

/* ------------------------------------------------------------------ stok */

export function lockedThrough(d) {
  const done = d.filter("stock_opname", (row) => row.status === "DONE");
  if (!done.length) return null;
  const max = done.reduce((acc, row) => {
    const value = String(row.period_end || "").slice(0, 10);
    return !acc || value > acc ? value : acc;
  }, null);
  return max || null;
}

export function assertPeriodOpen(d, value, action = "mengubah data") {
  const locked = lockedThrough(d);
  if (!locked) return;
  const target = isoDate(value);
  if (target <= locked) {
    throw new AppError(
      `Tanggal ${displayDate(target)} sudah dikunci oleh stok opname yang disahkan `
      + `(terkunci s.d. ${displayDate(locked)}). Tidak dapat ${action} pada tanggal tersebut. `
      + "Buka kembali pengesahan periode terakhir bila perlu koreksi.",
    );
  }
}

export function stockRows(d, cutoff = null) {
  const cut = cutoff ? isoDate(cutoff) : null;
  const events = new Map();
  const keyOf = (productId, size, location) => `${productId}|${size}|${location}`;
  const slot = (productId, size, location) => {
    const key = keyOf(productId, size, location);
    if (!events.has(key)) {
      events.set(key, {
        product_id: productId, size, location,
        stock: 0, incoming: 0, outgoing: 0, adjustment: 0, transfer_in: 0, transfer_out: 0,
      });
    }
    return events.get(key);
  };
  for (const t of d.all("transactions")) {
    if (cut && String(t.trx_date).slice(0, 10) > cut) continue;
    const qty = Number(t.qty || 0);
    const row = slot(Number(t.product_id), sqlSize(t.trx_size), sqlLoc(t.location));
    const isOpn = String(t.trx_number || "").startsWith("OPN-");
    if (t.trx_type === "MASUK") {
      row.stock += qty;
      if (!isOpn) row.incoming += qty;
      if (isOpn) row.adjustment += qty;
    } else {
      row.stock -= qty;
      if (!isOpn) row.outgoing += qty;
      if (isOpn) row.adjustment -= qty;
    }
  }
  for (const tr of d.all("location_transfers")) {
    if (cut && String(tr.transfer_date).slice(0, 10) > cut) continue;
    const qty = Number(tr.qty || 0);
    const size = sqlSize(tr.trx_size);
    slot(Number(tr.product_id), size, sqlLoc(tr.from_location)).stock -= qty;
    slot(Number(tr.product_id), size, sqlLoc(tr.from_location)).transfer_out += qty;
    slot(Number(tr.product_id), size, sqlLoc(tr.to_location)).stock += qty;
    slot(Number(tr.product_id), size, sqlLoc(tr.to_location)).transfer_in += qty;
  }
  const byProduct = new Map(d.all("products").map((row) => [Number(row.id), row]));
  const result = [];
  for (const row of events.values()) {
    if (Math.abs(row.stock) <= 0.0001) continue;
    const product = byProduct.get(row.product_id);
    if (!product) continue;
    result.push({
      product_id: row.product_id,
      code: product.code, name: product.name, unit: product.unit,
      purchase_price: product.purchase_price,
      size: row.size, location: row.location,
      stock: row.stock, incoming: row.incoming, outgoing: row.outgoing,
      adjustment: row.adjustment, transfer_in: row.transfer_in, transfer_out: row.transfer_out,
    });
  }
  result.sort((a, b) => nocase(a.name, b.name) || (a.size < b.size ? -1 : a.size > b.size ? 1 : 0) || (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  for (const row of result) {
    row.stock = pyRound(row.stock, 4);
    row.m3 = pyRound(m3Value(row.size, row.stock), 6);
    row.size_display = sizeDisplay(row.size);
  }
  return result;
}

/* Saldo terendah pada riwayat tanggal untuk satu barang+ukuran+lokasi.
   Stok "hari ini" bisa cukup padahal tanggal transaksi dimundurkan sehingga
   saldo pada tanggal tertentu minus (mis. mutasi/keluar bertanggal sebelum
   barang masuk). Dalam satu tanggal, penambahan dihitung lebih dulu. */
export function minStockOverTime(d, productId, size, location) {
  const wantedSize = sqlSize(size);
  const wantedLoc = sqlLoc(location);
  const events = [];
  for (const t of d.all("transactions")) {
    if (Number(t.product_id) !== Number(productId)) continue;
    if (sqlSize(t.trx_size) !== wantedSize || sqlLoc(t.location) !== wantedLoc) continue;
    const qty = Number(t.qty || 0);
    events.push({ date: String(t.trx_date).slice(0, 10), delta: t.trx_type === "MASUK" ? qty : -qty });
  }
  for (const tr of d.all("location_transfers")) {
    if (Number(tr.product_id) !== Number(productId) || sqlSize(tr.trx_size) !== wantedSize) continue;
    const qty = Number(tr.qty || 0);
    const date = String(tr.transfer_date).slice(0, 10);
    if (sqlLoc(tr.from_location) === wantedLoc) events.push({ date, delta: -qty });
    if (sqlLoc(tr.to_location) === wantedLoc) events.push({ date, delta: qty });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.delta - a.delta));
  let running = 0;
  let lowest = 0;
  for (const event of events) {
    running += event.delta;
    if (running < lowest) lowest = running;
  }
  return lowest;
}

/* Pagar riwayat stok: panggil sebelum mengubah data, lalu panggil fungsi yang
   dikembalikan sesudah mengubah. Galat dilempar bila perubahan menciptakan
   (atau memperdalam) saldo minus pada tanggal mana pun; engine membatalkan
   seluruh perubahan. Data lama yang sudah minus tidak membuat aksi baru macet. */
export function guardTimeline(d, entries) {
  const unique = new Map();
  for (const [productId, size, location] of entries) {
    unique.set(`${Number(productId)}|${sqlSize(size)}|${sqlLoc(location)}`, [productId, size, location]);
  }
  const before = new Map();
  for (const [key, [productId, size, location]] of unique) before.set(key, minStockOverTime(d, productId, size, location));
  return () => {
    for (const [key, [productId, size, location]] of unique) {
      const after = minStockOverTime(d, productId, size, location);
      if (after < -EPS && after < before.get(key) - EPS) {
        const product = d.one("products", Number(productId));
        throw new AppError(
          `Perubahan ini membuat stok ${product?.name || productId} ${sizeDisplay(sqlSize(size))} `
          + `@ ${sqlLoc(location) || "-"} minus pada riwayat tanggal (saldo terendah ${fmtQty(pyRound(after, 4))}). `
          + "Periksa tanggal transaksi: barang harus sudah masuk sebelum dikeluarkan atau dimutasi.",
        );
      }
    }
  };
}

export function stockMap(d, cutoff = null) {
  const map = new Map();
  for (const row of stockRows(d, cutoff)) {
    map.set(`${row.product_id}|${row.size || ""}|${row.location || ""}`, Number(row.stock || 0));
  }
  return map;
}

export function stockAt(d, productId, size, location) {
  const map = stockMap(d);
  return map.get(`${Number(productId)}|${normalizeSize(size)}|${sqlLoc(location)}`) || 0;
}

export function stockGrouped(d, query = "", location = "", thickness = "") {
  const rows = stockRows(d);
  const groups = new Map();
  const q = String(query || "").trim().toLowerCase();
  const locFilter = String(location || "").trim().toLowerCase();
  let tFilter = null;
  if (String(thickness || "").trim()) {
    const parsed = Number(String(thickness).replace(",", "."));
    tFilter = Number.isFinite(parsed) ? parsed : null;
  }
  for (const row of rows) {
    if (locFilter && String(row.location).toLowerCase() !== locFilter) continue;
    if (q && !`${row.code} ${row.name} ${row.size_display} ${row.location}`.toLowerCase().includes(q)) continue;
    if (tFilter !== null) {
      const [, tval] = sizeParts(row.size);
      if (Math.abs(tval - tFilter) > EPS) continue;
    }
    const key = `${Number(row.product_id)}|${row.size || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        product_id: Number(row.product_id), code: row.code, name: row.name, unit: row.unit,
        size: row.size, size_display: row.size_display, stock: 0, locations: {}, m3: 0,
      });
    }
    const group = groups.get(key);
    group.stock += Number(row.stock || 0);
    group.locations[row.location || ""] = Number(row.stock || 0);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.stock = pyRound(group.stock, 4);
    group.m3 = pyRound(m3Value(group.size, group.stock), 6);
    group.location_count = Object.keys(group.locations).length;
  }
  result.sort((a, b) => nocase(a.name, b.name) || (a.size < b.size ? -1 : a.size > b.size ? 1 : 0));
  return result;
}

function usedOfLot(d, trxId) {
  return d.filter("transactions", (row) => Number(row.source_trx_id) === Number(trxId) && row.trx_type === "KELUAR")
    .reduce((acc, row) => acc + Number(row.qty || 0), 0);
}

export function availableLots(d, productId, size, location = null) {
  const normalized = normalizeSize(size);
  const rows = d.filter("transactions", (row) => row.trx_type === "MASUK" && Number(row.product_id) === Number(productId))
    .filter((row) => sqlSize(row.trx_size) === normalized)
    .sort((a, b) => (a.trx_date < b.trx_date ? -1 : a.trx_date > b.trx_date ? 1 : Number(a.id) - Number(b.id)));
  let currentStock = null;
  if (location !== null) {
    currentStock = stockMap(d).get(`${Number(productId)}|${normalized}|${sqlLoc(location)}`) || 0;
  }
  const lots = [];
  for (const row of rows) {
    const remaining = pyRound(Number(row.qty || 0) - usedOfLot(d, row.id), 4);
    if (remaining <= EPS) continue;
    const capacity = currentStock === null ? remaining : Math.max(0, Math.min(remaining, currentStock));
    lots.push({
      id: row.id,
      trx_date: row.trx_date,
      trx_number: row.trx_number,
      delivery_number: row.delivery_number,
      supplier: row.supplier,
      location: row.location,
      qty: row.qty,
      price: row.price,
      note: row.note,
      created_at: row.created_at,
      used: usedOfLot(d, row.id),
      remaining,
      capacity: pyRound(capacity, 4),
      size: normalized,
      size_display: sizeDisplay(normalized),
    });
  }
  return lots;
}

export function lotCapacity(d, sourceId, location) {
  const lot = d.one("transactions", sourceId);
  if (!lot || lot.trx_type !== "MASUK") throw new AppError("Lot barang masuk sumber tidak ditemukan.");
  const normalized = normalizeSize(lot.trx_size);
  const remaining = pyRound(Number(lot.qty || 0) - usedOfLot(d, lot.id), 4);
  const stock = stockMap(d).get(`${Number(lot.product_id)}|${normalized}|${sqlLoc(location)}`) || 0;
  return {
    ...lot,
    size: normalized,
    size_display: sizeDisplay(normalized),
    remaining,
    location_stock: pyRound(stock, 4),
    capacity: pyRound(Math.max(0, Math.min(remaining, stock)), 4),
  };
}

export function recordOutgoing(d, userId, sourceId, location, qty, trxDate, note = "") {
  const qtyValue = Number(qty);
  if (!Number.isFinite(qtyValue)) throw new AppError("Qty harus berupa angka.");
  if (qtyValue <= 0) throw new AppError("Qty barang keluar harus lebih dari 0.");
  const targetDate = isoDate(trxDate, "Tanggal keluar");
  if (targetDate > todayISO()) throw new AppError("Tanggal keluar tidak boleh melewati hari ini.");
  assertPeriodOpen(d, targetDate, "mencatat barang keluar");
  const cleanLocation = String(location || "").trim();
  if (cleanLocation) resolveLocation(d, cleanLocation);
  const lot = lotCapacity(d, sourceId, cleanLocation);
  if (targetDate < String(lot.trx_date).slice(0, 10)) throw new AppError("Tanggal keluar tidak boleh sebelum tanggal barang masuk.");
  if (lot.remaining + EPS < qtyValue) {
    throw new AppError(`Sisa lot sumber hanya ${fmtQty(lot.remaining)}. Kurangi qty atau pilih lot lain.`);
  }
  if (lot.location_stock + EPS < qtyValue) {
    throw new AppError(
      `Stok barang ini di lokasi tersebut hanya ${fmtQty(lot.location_stock)}. `
      + `Tidak cukup untuk mengeluarkan ${fmtQty(qtyValue)}.`,
    );
  }
  if (String(note || "").length > 300) throw new AppError("Catatan maksimal 300 karakter.");
  const verifyTimeline = guardTimeline(d, [[lot.product_id, lot.size, cleanLocation]]);
  const newId = d.allocate("transactions");
  d.insert("transactions", {
    id: newId,
    trx_date: targetDate, trx_type: "KELUAR", product_id: Number(lot.product_id),
    qty: qtyValue, price: 0, note: String(note || "").trim(),
    trx_size: lot.size, location: cleanLocation,
    seller_id: lot.seller_id ?? null, rit_id: lot.rit_id ?? null,
    source_trx_id: Number(sourceId), trx_number: null, delivery_number: null,
    supplier: lot.supplier || "", user_id: userId ? Number(userId) : null, created_at: d.now,
  });
  verifyTimeline();
  log(d, userId, "BARANG_KELUAR",
    `id=${newId} | ${displayDate(targetDate)} | lot=${sourceId} | qty=${fmtQty(qtyValue)} | `
    + `ukuran=${sizeDisplay(lot.size)} | lokasi=${cleanLocation || "-"} | catatan=${String(note || "").trim()}`,
    "transactions", newId);
  return { id: newId };
}

export function updateOutgoing(d, userId, trxId, qty, trxDate, note, location) {
  const row = d.where("transactions", (item) => Number(item.id) === Number(trxId) && item.trx_type === "KELUAR");
  if (!row) throw new AppError("Transaksi barang keluar tidak ditemukan.", 404);
  const newQty = Number(qty);
  if (!Number.isFinite(newQty)) throw new AppError("Qty harus berupa angka.");
  if (newQty <= 0) throw new AppError("Qty harus lebih dari 0.");
  const newDate = isoDate(trxDate, "Tanggal keluar");
  const newLocation = String(location || "").trim();
  if (newDate > todayISO()) throw new AppError("Tanggal keluar tidak boleh melewati hari ini.");
  assertPeriodOpen(d, row.trx_date, "mengubah barang keluar");
  assertPeriodOpen(d, newDate, "mengubah barang keluar");
  if (newLocation) resolveLocation(d, newLocation);
  const sourceId = row.source_trx_id ?? null;
  if (sourceId) {
    const lot = lotCapacity(d, Number(sourceId), newLocation);
    if (newDate < String(lot.trx_date).slice(0, 10)) throw new AppError("Tanggal keluar tidak boleh sebelum tanggal barang masuk.");
    const maxQty = Number(lot.remaining || 0) + Number(row.qty || 0);
    if (newQty > maxQty + EPS) throw new AppError(`Qty melebihi sisa lot sumber. Maksimum: ${fmtQty(maxQty)}.`);
  }
  const oldLocation = String(row.location || "").trim();
  const oldSize = normalizeSize(row.trx_size);
  let projected = stockAt(d, Number(row.product_id), oldSize, newLocation);
  if (oldLocation === newLocation) projected += Number(row.qty || 0);
  if (projected + EPS < newQty) {
    throw new AppError(
      `Stok di lokasi tujuan hanya ${fmtQty(Math.max(0, projected))} setelah memperhitungkan transaksi ini. `
      + "Kurangi qty atau pilih lokasi lain.",
    );
  }
  const cleanNote = String(note || "").trim();
  if (cleanNote.length > 300) throw new AppError("Catatan maksimal 300 karakter.");
  const verifyTimeline = guardTimeline(d, [
    [row.product_id, oldSize, oldLocation], [row.product_id, oldSize, newLocation],
  ]);
  d.update("transactions", Number(trxId), {
    trx_date: newDate, qty: newQty, note: cleanNote, location: newLocation,
  });
  verifyTimeline();
  log(d, userId, "UBAH_BARANG_KELUAR",
    `id=${trxId} | sebelum: qty=${fmtQty(row.qty)} tgl=${row.trx_date} lokasi=${oldLocation || "-"} | `
    + `sesudah: qty=${fmtQty(newQty)} tgl=${newDate} lokasi=${newLocation || "-"} | catatan=${cleanNote}`,
    "transactions", Number(trxId));
  return { id: Number(trxId) };
}

export function cancelOutgoing(d, userId, ids, reason = "") {
  const cleanIds = (ids || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!cleanIds.length) throw new AppError("Pilih minimal satu transaksi barang keluar.");
  const rows = [];
  for (const trxId of cleanIds) {
    const row = d.where("transactions", (item) => Number(item.id) === Number(trxId) && item.trx_type === "KELUAR");
    if (!row) continue;
    assertPeriodOpen(d, row.trx_date, "membatalkan barang keluar");
    const product = d.one("products", Number(row.product_id));
    rows.push({ ...row, code: product?.code, name: product?.name });
  }
  if (!rows.length) throw new AppError("Tidak ada data barang keluar yang dapat dibatalkan.");
  const total = rows.reduce((acc, row) => acc + Number(row.qty || 0), 0);
  for (const row of rows) {
    d.delete("transactions", Number(row.id));
    log(d, userId, "BATAL_BARANG_KELUAR",
      `id=${row.id} | sumber=${row.source_trx_id ?? "-"} | qty=${fmtQty(row.qty)} | `
      + `ukuran=${sizeDisplay(row.trx_size)} | tgl=${row.trx_date} | `
      + `barang=${row.code} ${row.name} | alasan=${reason || "-"}`,
      "transactions", Number(row.id));
  }
  return { cancelled: rows.length, total_qty: pyRound(total, 4) };
}

export function listOutgoing(d, start, end, query = "") {
  const firstDay = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  })();
  const from = isoDate(start || firstDay, "Tanggal dari");
  const to = isoDate(end || todayISO(), "Tanggal sampai");
  if (from > to) throw new AppError("Tanggal dari tidak boleh melewati tanggal sampai.");
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  const sources = new Map(d.all("transactions").map((row) => [Number(row.id), row]));
  const rows = d.filter("transactions", (row) => row.trx_type === "KELUAR" && row.trx_date >= from && row.trx_date <= to)
    .filter((row) => {
      if (!String(query || "").trim()) return true;
      const product = d.one("products", Number(row.product_id)) || {};
      return likeIncludes(query, product.code, product.name, row.trx_size, row.note, row.location, row.supplier);
    })
    .sort((a, b) => (a.trx_date < b.trx_date ? 1 : a.trx_date > b.trx_date ? -1 : Number(b.id) - Number(a.id)));
  const locked = lockedThrough(d);
  const result = rows.map((row) => {
    const product = d.one("products", Number(row.product_id)) || {};
    const source = row.source_trx_id ? sources.get(Number(row.source_trx_id)) : null;
    return {
      id: row.id, trx_date: row.trx_date, qty: row.qty, note: row.note,
      trx_size: row.trx_size, location: row.location, supplier: row.supplier,
      price: row.price, trx_number: row.trx_number, delivery_number: row.delivery_number,
      created_at: row.created_at,
      code: product.code, name: product.name, unit: product.unit,
      username: users.get(Number(row.user_id))?.username ?? null,
      source_number: source?.trx_number ?? null, source_date: source?.trx_date ?? null,
      size_display: sizeDisplay(row.trx_size),
      qty_display: fmtQty(row.qty),
      is_locked: Boolean(locked && String(row.trx_date).slice(0, 10) <= locked),
      locked_through: locked,
    };
  });
  return result;
}

export function getOutgoing(d, trxId) {
  const row = d.where("transactions", (item) => Number(item.id) === Number(trxId) && item.trx_type === "KELUAR");
  if (!row) throw new AppError("Transaksi barang keluar tidak ditemukan.", 404);
  const product = d.one("products", Number(row.product_id)) || {};
  const user = row.user_id ? d.one("users", Number(row.user_id)) : null;
  const source = row.source_trx_id ? d.one("transactions", Number(row.source_trx_id)) : null;
  return {
    ...row,
    code: product.code, name: product.name, unit: product.unit,
    username: user?.username ?? null,
    source_number: source?.trx_number ?? null,
    source_date: source?.trx_date ?? null,
    source_delivery: source?.delivery_number ?? null,
    source_supplier: source?.supplier ?? null,
    source_qty: source?.qty ?? null,
    size_display: sizeDisplay(row.trx_size),
    m3: pyRound(m3Value(row.trx_size, row.qty), 6),
  };
}

export function recordTransfer(d, userId, productId, size, fromLocation, toLocation, qty, transferDate, note = "") {
  const normalized = normalizeSize(size);
  const from = String(fromLocation || "").trim();
  const to = String(toLocation || "").trim();
  if (!from) throw new AppError("Lokasi asal wajib diisi.");
  resolveLocation(d, from);
  resolveLocation(d, to);
  if (from.toLowerCase() === to.toLowerCase()) throw new AppError("Lokasi tujuan harus berbeda dari lokasi asal.");
  const qtyValue = Number(qty);
  if (!Number.isFinite(qtyValue)) throw new AppError("Qty mutasi harus berupa angka.");
  if (qtyValue <= 0) throw new AppError("Qty mutasi harus lebih dari 0.");
  const targetDate = isoDate(transferDate, "Tanggal mutasi");
  if (targetDate > todayISO()) throw new AppError("Tanggal mutasi tidak boleh melewati hari ini.");
  assertPeriodOpen(d, targetDate, "mencatat mutasi");
  const available = stockAt(d, productId, normalized, from);
  if (available + EPS < qtyValue) throw new AppError(`Stok di ${from} tidak cukup. Tersedia ${fmtQty(available)}.`);
  const cleanNote = String(note || "").trim();
  if (cleanNote.length > 300) throw new AppError("Catatan maksimal 300 karakter.");
  const verifyTimeline = guardTimeline(d, [[productId, normalized, from], [productId, normalized, to]]);
  const newId = d.allocate("location_transfers");
  d.insert("location_transfers", {
    id: newId,
    transfer_date: targetDate, product_id: Number(productId), trx_size: normalized,
    from_location: from, to_location: to, qty: qtyValue, note: cleanNote,
    user_id: userId ? Number(userId) : null, created_at: d.now,
  });
  verifyTimeline();
  log(d, userId, "MUTASI_LOKASI",
    `id=${newId} | ${displayDate(targetDate)} | produk=${productId} | ukuran=${sizeDisplay(normalized)} | `
    + `qty=${fmtQty(qtyValue)} | ${from} → ${to} | catatan=${cleanNote}`,
    "location_transfers", newId);
  return { id: newId };
}

export function listTransfers(d, start = "", end = "", query = "") {
  let rows = d.all("location_transfers");
  if (String(start || "").trim()) rows = rows.filter((row) => row.transfer_date >= isoDate(start, "Tanggal dari"));
  if (String(end || "").trim()) rows = rows.filter((row) => row.transfer_date <= isoDate(end, "Tanggal sampai"));
  if (String(query || "").trim()) {
    rows = rows.filter((row) => {
      const product = d.one("products", Number(row.product_id)) || {};
      return likeIncludes(query, product.code, product.name, row.from_location, row.to_location, row.note);
    });
  }
  rows = rows.slice().sort((a, b) => (a.transfer_date < b.transfer_date ? 1 : a.transfer_date > b.transfer_date ? -1 : Number(b.id) - Number(a.id)));
  return rows.map((row) => {
    const product = d.one("products", Number(row.product_id)) || {};
    const user = row.user_id ? d.one("users", Number(row.user_id)) : null;
    return {
      ...row,
      code: product.code, name: product.name, unit: product.unit,
      username: user?.username ?? null,
      size_display: sizeDisplay(row.trx_size),
      qty_display: fmtQty(row.qty),
      m3: pyRound(m3Value(row.trx_size, row.qty), 6),
    };
  });
}

function cmpSortKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function stockCard(d, productId, size, location, start, end) {
  const normalized = normalizeSize(size);
  const cleanLocation = String(location || "").trim();
  const from = isoDate(start, "Tanggal dari");
  const to = isoDate(end, "Tanggal sampai");
  if (from > to) throw new AppError("Tanggal dari tidak boleh melewati tanggal sampai.");
  const product = d.one("products", Number(productId));
  if (!product) throw new AppError("Barang tidak ditemukan.", 404);
  const opening = stockMap(d, addDaysLocal(from, -1)).get(`${Number(productId)}|${normalized}|${cleanLocation}`) || 0;
  const movements = [];
  const trx = d.filter("transactions", (row) => Number(row.product_id) === Number(productId)
    && sqlSize(row.trx_size) === normalized
    && sqlLoc(row.location) === cleanLocation
    && row.trx_date >= from && row.trx_date <= to);
  for (const row of trx) {
    const isOpn = String(row.trx_number || "").startsWith("OPN-");
    let label = row.trx_type === "MASUK" ? "MASUK" : "KELUAR";
    if (isOpn) label = "PENYESUAIAN OPNAME";
    movements.push({
      date: String(row.trx_date).slice(0, 10), kind: label,
      in_qty: row.trx_type === "MASUK" ? Number(row.qty || 0) : 0,
      out_qty: row.trx_type === "KELUAR" ? Number(row.qty || 0) : 0,
      reference: row.trx_number || "",
      note: row.note || "",
      sort: [String(row.trx_date).slice(0, 10), 1, Number(row.id)],
    });
  }
  const transfers = d.filter("location_transfers", (row) => Number(row.product_id) === Number(productId)
    && sqlSize(row.trx_size) === normalized
    && (sqlLoc(row.from_location) === cleanLocation || sqlLoc(row.to_location) === cleanLocation)
    && row.transfer_date >= from && row.transfer_date <= to);
  for (const row of transfers) {
    const inQty = sqlLoc(row.to_location) === cleanLocation ? Number(row.qty || 0) : 0;
    const outQty = sqlLoc(row.from_location) === cleanLocation ? Number(row.qty || 0) : 0;
    movements.push({
      date: String(row.transfer_date).slice(0, 10),
      kind: inQty > 0 ? "MUTASI MASUK" : "MUTASI KELUAR",
      in_qty: inQty, out_qty: outQty,
      reference: `${row.from_location} → ${row.to_location}`,
      note: row.note || "",
      sort: [String(row.transfer_date).slice(0, 10), 2, Number(row.id)],
    });
  }
  movements.sort((a, b) => cmpSortKey(a.sort, b.sort));
  let balance = Number(opening);
  for (const row of movements) {
    balance = pyRound(balance + row.in_qty - row.out_qty, 4);
    row.balance = balance;
  }
  const volumeOpening = opening ? m3Value(normalized, opening) : 0;
  const volumeIn = movements.reduce((acc, row) => acc + m3Value(normalized, row.in_qty), 0);
  const volumeOut = movements.reduce((acc, row) => acc + m3Value(normalized, row.out_qty), 0);
  return {
    product: { id: product.id, code: product.code, name: product.name, unit: product.unit, purchase_price: product.purchase_price },
    size: normalized, size_display: sizeDisplay(normalized),
    location: cleanLocation, start: from, end: to,
    opening: pyRound(Number(opening), 4), opening_m3: pyRound(volumeOpening, 6),
    in_m3: pyRound(volumeIn, 6), out_m3: pyRound(volumeOut, 6),
    closing: pyRound(balance, 4), closing_m3: pyRound(m3Value(normalized, balance), 6),
    movements,
  };
}

function addDaysLocal(isoValue, days) {
  const { year, month, day } = parseISODate(isoValue);
  const probe = new Date(year, month - 1, day + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${probe.getFullYear()}-${pad(probe.getMonth() + 1)}-${pad(probe.getDate())}`;
}

export function priceReference(d) {
  const totals = new Map();
  for (const row of d.all("transactions")) {
    if (row.trx_type !== "MASUK" || Number(row.price || 0) <= 0) continue;
    if (String(row.trx_number || "").startsWith("OPN-")) continue;
    const size = normalizeSize(row.trx_size);
    const volume = m3Value(size, row.qty);
    const amount = volume * Number(row.price || 0);
    const key = `${Number(row.product_id)}|${size}`;
    const bucket = totals.get(key) || [0, 0];
    bucket[0] += volume;
    bucket[1] += amount;
    totals.set(key, bucket);
  }
  const result = new Map();
  for (const [key, [volume, amount]] of totals.entries()) {
    if (volume > EPS) result.set(key, amount / volume);
  }
  return result;
}

export function stockLotsDetail(d, productId, size, location) {
  const normalized = normalizeSize(size);
  const lots = availableLots(d, productId, normalized, location);
  for (const lot of lots) {
    lot.available = lot.capacity;
    lot.m3_remaining = pyRound(m3Value(normalized, lot.remaining), 6);
  }
  return lots;
}

export function recentOutgoingLots(d, productId, size, location, limit = 10) {
  const normalized = normalizeSize(size);
  return d.filter("transactions", (row) => row.trx_type === "KELUAR"
    && Number(row.product_id) === Number(productId)
    && sqlSize(row.trx_size) === normalized
    && sqlLoc(row.location) === sqlLoc(location))
    .sort((a, b) => (a.trx_date < b.trx_date ? 1 : a.trx_date > b.trx_date ? -1 : Number(b.id) - Number(a.id)))
    .slice(0, Number(limit))
    .map((row) => ({
      id: row.id, trx_date: row.trx_date, qty: row.qty, note: row.note,
      supplier: row.supplier,
      username: row.user_id ? d.one("users", Number(row.user_id))?.username ?? null : null,
    }));
}

/* ------------------------------------------------------- master umum */

export function resolveSellerId(d, value, allowInactive = false) {
  if (value === null || value === undefined || value === "") return null;
  let row = null;
  if (Number.isInteger(value) || (typeof value === "string" && /^\d+$/.test(value))) {
    row = d.one("sellers", Number(value));
  } else {
    const name = String(value).trim().toLowerCase();
    row = d.where("sellers", (item) => String(item.name).toLowerCase() === name);
  }
  if (!row) throw new AppError("Penjual tidak ditemukan.");
  if (!row.active && !allowInactive) throw new AppError("Penjual berstatus nonaktif.");
  return Number(row.id);
}

export function resolveLocation(d, value, allowInactive = false) {
  const name = String(value || "").trim();
  if (!name) throw new AppError("Lokasi wajib dipilih.");
  const lower = name.toLowerCase();
  const row = d.where("storage_locations", (item) => String(item.code).toLowerCase() === lower || String(item.name).toLowerCase() === lower);
  if (!row) throw new AppError("Lokasi tidak ditemukan pada data master.");
  if (!row.active && !allowInactive) throw new AppError(`Lokasi ${name} berstatus nonaktif.`);
  return String(row.code).trim();
}

/* ------------------------------------------------- penerimaan lokal (nota) */

export function normalizeNoteNumber(value) {
  let raw = String(value || "").trim().toUpperCase();
  if (raw.startsWith("BR-")) raw = raw.slice(3).trim();
  if (!(raw.length >= 3 && raw.length <= 6 && /^\d+$/.test(raw))) {
    throw new AppError("Nomor nota harus 3 sampai 6 digit angka setelah prefix BR-.");
  }
  return `BR-${raw}`;
}

export function displayNote(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  return text.toUpperCase().startsWith("BR-") ? text : `BR-${text}`;
}

function checkThickness(d, value) {
  const thickness = Number(String(value).replace(",", "."));
  if (!Number.isFinite(thickness)) throw new AppError("Tebal (T) harus berupa angka.");
  if (thickness <= 0) throw new AppError("Tebal (T) harus lebih dari 0.");
  if (thickness > 60) throw new AppError("Tebal (T) maksimal 60 mm.");
  const active = d.filter("master_spec_values", (row) => row.dimension === "T" && row.active)
    .map((row) => Number(row.value));
  if (active.length && !active.some((value2) => Math.abs(thickness - value2) < EPS)) {
    const options = active.slice().sort((a, b) => a - b).map((v) => trimNumber(v)).join(", ");
    throw new AppError(`Tebal (T) harus dipilih dari master (${options}).`);
  }
  return thickness;
}

function checkPrice(d, value) {
  let price;
  if (typeof value === "number") price = value;
  else {
    const text = String(value || "").trim();
    price = Number(text);
    if (!Number.isFinite(price)) price = Number(text.replace(/\./g, "").replace(",", "."));
  }
  if (!Number.isFinite(price)) throw new AppError("Harga per m³ harus berupa angka.");
  if (price <= 0) throw new AppError("Harga per m³ harus lebih dari 0.");
  const active = d.filter("master_price_values", (row) => row.active).map((row) => Number(row.price));
  if (active.length && !active.some((value2) => Math.abs(price - value2) < 0.5)) {
    throw new AppError("Harga per m³ harus dipilih dari master harga.");
  }
  return price;
}

function sellerRow(d, sellerId) {
  const row = d.one("sellers", Number(sellerId));
  if (!row) throw new AppError("Penjual tidak ditemukan.", 404);
  if (!row.active) throw new AppError("Penjual berstatus nonaktif.");
  return row;
}

export function ritRow(d, ritId) {
  const row = d.one("seller_rits", Number(ritId));
  if (!row) throw new AppError("Rit tidak ditemukan.", 404);
  const seller = d.one("sellers", Number(row.seller_id));
  return { ...row, seller_name: seller?.name ?? null, seller_active: seller?.active ?? null };
}

export function validateDimensionsStandard(d, size, allowImport = false) {
  const [l, t, p] = sizeParts(size);
  if (allowImport) {
    if (l > 200 || t > 100 || p > 2000) throw new AppError("Ukuran melebihi batas aman. Periksa kembali T, L, dan P.");
    return;
  }
  if (t > 60) throw new AppError(`Tebal (T) maksimal 60 mm. Nilai sekarang ${trimNumber(t)} mm.`);
  if (l > 20) throw new AppError(`Lebar (L) maksimal 20 cm. Nilai sekarang ${trimNumber(l)} cm.`);
  if (p > 999) throw new AppError(`Panjang (P) maksimal 999 cm. Nilai sekarang ${trimNumber(p)} cm.`);
  const active = {};
  for (const row of d.filter("master_spec_values", (item) => item.active)) {
    const set = active[row.dimension] || new Set();
    set.add(Number(Number(row.value).toFixed(6)));
    active[row.dimension] = set;
  }
  const checks = [["L", l], ["T", t], ["P", p]];
  const labels = { L: "Lebar (L)", T: "Tebal (T)", P: "Panjang (P)" };
  for (const [key, value] of checks) {
    const values = active[key];
    if (values && values.size && !values.has(Number(Number(value).toFixed(6)))) {
      const options = [...values].sort((a, b) => a - b).map((v) => trimNumber(v)).join(", ");
      throw new AppError(`${labels[key]} harus dipilih dari master (${options}).`);
    }
  }
}

export function generateNameCode(d, name, table = "products") {
  if (table !== "products") throw new AppError("Tabel kode otomatis tidak dikenal.");
  const letters = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!letters) throw new AppError("Nama wajib diisi untuk membuat kode.");
  let base = [0, 2, 4].filter((i) => i < letters.length).map((i) => letters[i]).join("");
  if (base.length < 2) base = (letters + "BRG").slice(0, 3);
  const candidates = [base];
  const extras = letters.slice(1).split("").filter((_, i) => i % 2 === 0).join("") + letters.slice(5);
  for (const ch of extras) {
    base += ch;
    candidates.push(base);
  }
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    candidates.push(`${candidates[0]}${String(suffix).padStart(2, "0")}`);
  }
  for (const code of candidates) {
    const exists = d.where("products", (row) => String(row.code).toLowerCase() === code.toLowerCase());
    if (!exists) return code.toUpperCase();
  }
  throw new AppError("Tidak dapat membuat kode unik. Gunakan nama lain.");
}

export function listRits(d, sellerId, month = "") {
  sellerRow(d, sellerId);
  let rows = d.filter("seller_rits", (row) => Number(row.seller_id) === Number(sellerId));
  if (String(month || "").trim()) rows = rows.filter((row) => row.rit_month === String(month).trim());
  rows = rows.slice().sort((a, b) => (a.rit_date < b.rit_date ? 1 : a.rit_date > b.rit_date ? -1 : Number(b.id) - Number(a.id)));
  const totals = new Map();
  for (const trx of d.all("transactions")) {
    if (trx.rit_id === null || trx.rit_id === undefined || trx.trx_type !== "MASUK") continue;
    const key = Number(trx.rit_id);
    const bucket = totals.get(key) || { notes: new Set(), lines: 0, qty: 0, volume: 0, amount: 0 };
    bucket.notes.add(trx.trx_number || "");
    bucket.lines += 1;
    bucket.qty += Number(trx.qty || 0);
    const volume = m3Value(trx.trx_size, trx.qty);
    bucket.volume += volume;
    bucket.amount += volume * Number(trx.price || 0);
    totals.set(key, bucket);
  }
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  const locked = lockedThrough(d);
  return rows.map((row) => {
    const bucket = totals.get(Number(row.id)) || { notes: new Set(), lines: 0, qty: 0, volume: 0, amount: 0 };
    return {
      ...row,
      seller_name: d.one("sellers", Number(row.seller_id))?.name ?? null,
      username: users.get(Number(row.user_id))?.username ?? null,
      notes_count: [...bucket.notes].filter(Boolean).length,
      lines_count: bucket.lines,
      qty: pyRound(bucket.qty, 4),
      volume: pyRound(bucket.volume, 6),
      amount: pyRound(bucket.amount, 2),
      qty_display: fmtQty(pyRound(bucket.qty, 4)),
      rit_number_display: pad2(row.rit_number),
      is_locked: Boolean(locked && String(row.rit_date).slice(0, 10) <= locked),
    };
  });
}

export function createRit(d, userId, sellerId, ritNumber, ritDate, deliveryNumber, note = "") {
  const seller = sellerRow(d, sellerId);
  const number = Number(String(ritNumber).trim());
  if (!Number.isInteger(number)) throw new AppError("Nomor rit harus berupa angka bulat.");
  if (number <= 0) throw new AppError("Nomor rit harus lebih dari 0.");
  const targetDate = isoDate(ritDate, "Tanggal rit");
  if (targetDate > todayISO()) throw new AppError("Tanggal rit tidak boleh melewati hari ini.");
  assertPeriodOpen(d, targetDate, "menambah rit");
  const delivery = String(deliveryNumber || "").trim();
  if (delivery.length > 80) throw new AppError("Nomor surat jalan maksimal 80 karakter.");
  const cleanNote = String(note || "").trim();
  if (cleanNote.length > 300) throw new AppError("Catatan rit maksimal 300 karakter.");
  const month = targetDate.slice(0, 7);
  const conflict = d.where("seller_rits", (row) => Number(row.seller_id) === Number(sellerId)
    && row.rit_month === month && Number(row.rit_number) === number);
  if (conflict) throw new AppError(`Rit ${pad2(number)} untuk ${seller.name} pada bulan ini sudah ada.`);
  const newId = d.allocate("seller_rits");
  d.insert("seller_rits", {
    id: newId, seller_id: Number(sellerId), rit_number: number, rit_date: targetDate,
    rit_month: month, delivery_number: delivery, note: cleanNote,
    user_id: userId ? Number(userId) : null, created_at: d.now,
  });
  log(d, userId, "RIT_TAMBAH",
    `id=${newId} | ${seller.name} | rit=${pad2(number)} | ${targetDate} | SJ=${delivery}`,
    "seller_rits", newId);
  return { id: newId };
}

export function updateRit(d, userId, ritId, ritNumber, ritDate, deliveryNumber, note = "") {
  const rit = ritRow(d, ritId);
  const targetDate = isoDate(ritDate, "Tanggal rit");
  if (targetDate > todayISO()) throw new AppError("Tanggal rit tidak boleh melewati hari ini.");
  assertPeriodOpen(d, rit.rit_date, "mengubah rit");
  assertPeriodOpen(d, targetDate, "mengubah rit");
  const number = Number(String(ritNumber).trim());
  if (!Number.isInteger(number)) throw new AppError("Nomor rit harus berupa angka bulat.");
  if (number <= 0) throw new AppError("Nomor rit harus lebih dari 0.");
  const delivery = String(deliveryNumber || "").trim();
  const month = targetDate.slice(0, 7);
  const conflict = d.where("seller_rits", (row) => Number(row.seller_id) === Number(rit.seller_id)
    && row.rit_month === month && Number(row.rit_number) === number && Number(row.id) !== Number(ritId));
  if (conflict) throw new AppError(`Rit ${pad2(number)} untuk penjual ini pada bulan tersebut sudah ada.`);
  const trx = d.filter("transactions", (row) => Number(row.rit_id) === Number(ritId));
  for (const line of trx) {
    const blockers = noteLineBlockers(d, Number(line.id));
    if (blockers.tally || blockers.recap || blockers.outgoing) throw new AppError(blockerMessage(blockers));
  }
  const cleanNote = String(note || "").trim();
  if (cleanNote.length > 300) throw new AppError("Catatan rit maksimal 300 karakter.");
  d.update("seller_rits", Number(ritId), {
    rit_number: number, rit_date: targetDate, rit_month: month,
    delivery_number: delivery, note: cleanNote,
  });
  log(d, userId, "RIT_UBAH",
    `id=${ritId} | rit=${pad2(number)} | ${targetDate} | SJ=${delivery}`,
    "seller_rits", Number(ritId));
  return { id: Number(ritId) };
}

export function deleteRit(d, userId, ritId) {
  const rit = ritRow(d, ritId);
  const hasTrx = d.where("transactions", (row) => Number(row.rit_id) === Number(ritId));
  if (hasTrx) throw new AppError("Rit masih memiliki transaksi. Hapus transaksi/nota terlebih dahulu.");
  d.delete("seller_rits", Number(ritId));
  log(d, userId, "RIT_HAPUS",
    `id=${ritId} | ${rit.seller_name} | rit=${pad2(rit.rit_number)} | ${rit.rit_date}`,
    "seller_rits", Number(ritId));
  return { deleted: true };
}

function groupRows(rows) {
  const groups = new Map();
  for (const original of rows) {
    const key = original.trx_number || "";
    if (!groups.has(key)) {
      groups.set(key, {
        note: key || "(tanpa nomor nota)",
        note_raw: key,
        trx_ids: [],
        lines: [],
        qty: 0,
        volume: 0,
        amount: 0,
        products: new Set(),
        dates: [],
      });
    }
    const group = groups.get(key);
    const volume = m3Value(original.trx_size, original.qty);
    const amount = volume * Number(original.price || 0);
    const row = {
      ...original,
      size_display: sizeDisplay(original.trx_size),
      volume: pyRound(volume, 6),
      amount: pyRound(amount, 2),
    };
    group.trx_ids.push(Number(row.id));
    group.lines.push(row);
    group.qty += Number(row.qty || 0);
    group.volume += volume;
    group.amount += amount;
    group.products.add(Number(row.product_id));
    group.dates.push(String(row.trx_date).slice(0, 10));
  }
  const result = [];
  for (const group of groups.values()) {
    group.qty = pyRound(group.qty, 4);
    group.volume = pyRound(group.volume, 6);
    group.amount = pyRound(group.amount, 2);
    group.date = group.dates.length ? group.dates.reduce((a, b) => (a > b ? a : b)) : null;
    group.lines_count = group.lines.length;
    group.products_count = group.products.size;
    delete group.dates;
    delete group.products;
    result.push(group);
  }
  result.sort((a, b) => {
    const dateA = a.date || "";
    const dateB = b.date || "";
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    return a.note < b.note ? 1 : a.note > b.note ? -1 : 0;
  });
  return result;
}

export function listNotes(d, ritId) {
  const rit = ritRow(d, ritId);
  const products = new Map(d.all("products").map((row) => [Number(row.id), row]));
  const rows = d.filter("transactions", (row) => Number(row.rit_id) === Number(ritId) && row.trx_type === "MASUK")
    .sort((a, b) => (a.trx_date < b.trx_date ? -1 : a.trx_date > b.trx_date ? 1 : Number(a.id) - Number(b.id)))
    .map((row) => {
      const product = products.get(Number(row.product_id)) || {};
      return { ...row, code: product.code, name: product.name, unit: product.unit };
    });
  const groups = groupRows(rows);
  const tallies = d.filter("tally_headers", (row) => Number(row.rit_id) === Number(ritId))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((row) => ({
      id: row.id, tally_number: row.tally_number, note: row.note, status: row.status,
      total_qty: row.total_qty, total_volume: row.total_volume, total_amount: row.total_amount,
      created_at: row.created_at,
    }));
  const recaps = d.filter("payment_recap_headers", (row) => Number(row.rit_id) === Number(ritId))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((row) => ({
      id: row.id, recap_number: row.recap_number, note: row.note, status: row.status,
      total_qty: row.total_qty, total_volume: row.total_volume, total_amount: row.total_amount,
      created_at: row.created_at,
    }));
  const locked = lockedThrough(d);
  for (const group of groups) {
    group.tallies = tallies.filter((t) => (t.note || "") === group.note_raw);
    group.recaps = recaps.filter((r) => (r.note || "") === group.note_raw);
    const activeTallies = group.tallies.filter((t) => t.status === "POSTED");
    const activeRecaps = group.recaps.filter((r) => r.status === "AKTIF");
    group.has_active_tally = Boolean(activeTallies.length);
    group.has_active_recap = Boolean(activeRecaps.length);
    group.tally_numbers = activeTallies.map((t) => t.tally_number);
    group.recap_numbers = activeRecaps.map((r) => r.recap_number);
    group.is_locked = Boolean(group.date && locked && group.date <= locked);
  }
  return { rit, notes: groups };
}

export function getNote(d, ritId, note) {
  const rit = ritRow(d, ritId);
  const cleanNote = String(note || "").trim();
  const products = new Map(d.all("products").map((row) => [Number(row.id), row]));
  const rows = d.filter("transactions", (row) => Number(row.rit_id) === Number(ritId)
    && row.trx_type === "MASUK" && (row.trx_number || "") === cleanNote)
    .sort((a, b) => (a.trx_date < b.trx_date ? -1 : a.trx_date > b.trx_date ? 1 : Number(a.id) - Number(b.id)))
    .map((row) => {
      const product = products.get(Number(row.product_id)) || {};
      return { ...row, code: product.code, name: product.name, unit: product.unit };
    });
  if (!rows.length) throw new AppError("Nota tidak ditemukan.", 404);
  const locked = lockedThrough(d);
  const lines = [];
  const totals = { qty: 0, volume: 0, amount: 0 };
  for (const row of rows) {
    const blockers = noteLineBlockers(d, Number(row.id));
    const volume = m3Value(row.trx_size, row.qty);
    const amount = volume * Number(row.price || 0);
    const [l, t, p] = sizeParts(row.trx_size);
    lines.push({
      ...row,
      size_display: sizeDisplay(row.trx_size),
      l: trimNumber(l), t: trimNumber(t), p: trimNumber(p),
      volume: pyRound(volume, 6), amount: pyRound(amount, 2),
      blockers,
      can_edit: !(blockers.tally || blockers.recap || blockers.outgoing)
        && !(locked && String(row.trx_date).slice(0, 10) <= locked),
    });
    totals.qty += Number(row.qty || 0);
    totals.volume += volume;
    totals.amount += amount;
  }
  const latest = lines[lines.length - 1];
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  const tallies = d.filter("tally_headers", (row) => Number(row.rit_id) === Number(ritId) && (row.note || "") === cleanNote)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((row) => ({ ...row, username: users.get(Number(row.created_by))?.username ?? null }));
  const recaps = d.filter("payment_recap_headers", (row) => Number(row.rit_id) === Number(ritId) && (row.note || "") === cleanNote)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((row) => ({ ...row, username: users.get(Number(row.created_by))?.username ?? null }));
  return {
    rit,
    note: cleanNote,
    note_display: displayNote(cleanNote),
    date: String(latest.trx_date).slice(0, 10),
    thickness: latest.t,
    price: latest.price,
    location: latest.location,
    delivery_number: latest.delivery_number || rit.delivery_number,
    supplier: latest.supplier || rit.seller_name,
    lines,
    totals: {
      qty: pyRound(totals.qty, 4),
      volume: pyRound(totals.volume, 6),
      amount: pyRound(totals.amount, 2),
      qty_display: fmtQty(pyRound(totals.qty, 4)),
    },
    tallies,
    recaps,
  };
}

export function noteLineBlockers(d, trxId) {
  const tally = d.where("tally_items", (item) => Number(item.trx_id) === Number(trxId));
  let tallyNumber = null;
  if (tally) {
    const header = d.one("tally_headers", Number(tally.tally_id));
    if (header && header.status === "POSTED") tallyNumber = header.tally_number;
  }
  const recapNumber = findActiveRecapForTrx(d, trxId);
  const outgoing = d.where("transactions", (row) => row.trx_type === "KELUAR" && Number(row.source_trx_id) === Number(trxId));
  return {
    tally: tallyNumber,
    recap: recapNumber,
    outgoing: outgoing ? Number(outgoing.id) : null,
  };
}

function findActiveRecapForTrx(d, trxId) {
  for (const item of d.filter("payment_recap_items", (row) => Number(row.trx_id) === Number(trxId) && row.active === 1)) {
    const header = d.one("payment_recap_headers", Number(item.recap_id));
    if (header && header.status === "AKTIF") return header.recap_number;
  }
  return null;
}

export function blockerMessage(blockers) {
  const parts = [];
  if (blockers.tally) parts.push(`tally ${blockers.tally} masih aktif`);
  if (blockers.recap) parts.push(`rekap pembayaran ${blockers.recap} masih aktif`);
  if (blockers.outgoing) parts.push(`stok sudah dipakai barang keluar #${blockers.outgoing}`);
  return "Tidak dapat mengubah data karena " + parts.join(", ") + ".";
}

function upsertActivePrice(d, productId, priceValue, stamp, userId) {
  const existing = d.where("product_active_prices", (row) => Number(row.product_id) === Number(productId));
  if (existing) {
    d.update("product_active_prices", Number(productId), {
      active_price: priceValue, updated_at: stamp, updated_by: userId ? Number(userId) : null,
    });
  } else {
    /* tabel 1:1 dengan products: id dokumen = product_id (seperti rowid SQLite). */
    d.insert("product_active_prices", {
      id: Number(productId), product_id: Number(productId), active_price: priceValue,
      updated_at: stamp, updated_by: userId ? Number(userId) : null,
    });
  }
}

export function addNoteLine(d, userId, ritId, note, trxDate, thickness, price,
  location, productId, width, length, qty, lineNote = "") {
  const rit = ritRow(d, ritId);
  if (!rit.seller_active) throw new AppError("Penjual berstatus nonaktif.");
  const cleanNote = normalizeNoteNumber(note);
  const targetDate = isoDate(trxDate, "Tanggal nota");
  if (targetDate > todayISO()) throw new AppError("Tanggal nota tidak boleh melewati hari ini.");
  assertPeriodOpen(d, targetDate, "mencatat barang masuk");
  const activeDocument = findActiveDocumentForNote(d, Number(ritId), cleanNote);
  if (activeDocument) {
    throw new AppError(
      `Nota ini sudah memiliki ${activeDocument.kind} ${activeDocument.document} aktif `
      + "sehingga baris baru tidak dapat ditambahkan.",
    );
  }
  const tValue = checkThickness(d, thickness);
  const priceValue = checkPrice(d, price);
  const locationValue = resolveLocation(d, location);
  const product = d.one("products", Number(productId));
  if (!product) throw new AppError("Barang tidak ditemukan.", 404);
  if (!product.active) throw new AppError("Barang berstatus nonaktif.");
  if (String(product.code).toUpperCase().startsWith("IMP/")) {
    throw new AppError("Barang impor tidak dapat dipakai pada Penerimaan Lokal.");
  }
  const qtyValue = Number(qty);
  if (!Number.isFinite(qtyValue)) throw new AppError("Qty harus berupa angka.");
  if (qtyValue <= 0) throw new AppError("Qty harus lebih dari 0.");
  const size = makeSize(tValue, width, length);
  validateDimensionsStandard(d, size);
  const cleanLineNote = String(lineNote || "").trim();
  if (cleanLineNote.length > 300) throw new AppError("Catatan baris maksimal 300 karakter.");
  const newId = d.allocate("transactions");
  d.insert("transactions", {
    id: newId,
    trx_date: targetDate, trx_type: "MASUK", product_id: Number(productId),
    qty: qtyValue, price: priceValue, note: cleanLineNote,
    trx_size: size, location: locationValue,
    seller_id: Number(rit.seller_id), rit_id: Number(ritId), source_trx_id: null,
    trx_number: cleanNote, delivery_number: rit.delivery_number, supplier: rit.seller_name,
    user_id: userId ? Number(userId) : null, created_at: d.now,
  });
  upsertActivePrice(d, Number(productId), priceValue, d.now, userId);
  log(d, userId, "BARANG_MASUK",
    `id=${newId} | ${displayDate(targetDate)} | nota=${cleanNote} | `
    + `barang=${product.code} ${product.name} | ukuran=${sizeDisplay(size)} | qty=${fmtQty(qtyValue)} | `
    + `harga=${pyFloatStr(priceValue)} | lokasi=${locationValue} | penjual=${rit.seller_name}`,
    "transactions", newId);
  return { id: newId, note: cleanNote };
}

function findActiveDocumentForNote(d, ritId, cleanNote) {
  for (const header of d.filter("tally_headers", (row) => Number(row.rit_id) === Number(ritId)
    && String(row.note || "").trim().toUpperCase() === cleanNote.toUpperCase() && row.status === "POSTED")) {
    return { document: header.tally_number, kind: "tally" };
  }
  for (const header of d.filter("payment_recap_headers", (row) => Number(row.rit_id) === Number(ritId)
    && String(row.note || "").trim().toUpperCase() === cleanNote.toUpperCase() && row.status === "AKTIF")) {
    return { document: header.recap_number, kind: "rekap pembayaran" };
  }
  return null;
}

export function updateNote(d, userId, ritId, note, trxDate, thickness, price, location, newNote = null) {
  const rit = ritRow(d, ritId);
  const oldNote = String(note || "").trim();
  const targetNote = normalizeNoteNumber(String(newNote || "").trim() ? newNote : note);
  const targetDate = isoDate(trxDate, "Tanggal nota");
  if (targetDate > todayISO()) throw new AppError("Tanggal nota tidak boleh melewati hari ini.");
  const locked = lockedThrough(d);
  if (locked && (String(rit.rit_date).slice(0, 10) <= locked || targetDate <= locked)) {
    throw new AppError("Nota berada pada periode yang sudah ditutup dan tidak dapat diubah.");
  }
  assertPeriodOpen(d, targetDate, "mengubah nota");
  const tValue = checkThickness(d, thickness);
  const priceValue = checkPrice(d, price);
  const locationValue = resolveLocation(d, location);
  const rows = d.filter("transactions", (row) => Number(row.rit_id) === Number(ritId)
    && row.trx_type === "MASUK" && (row.trx_number || "") === oldNote);
  if (!rows.length) throw new AppError("Nota tidak ditemukan.", 404);
  for (const row of rows) {
    assertPeriodOpen(d, row.trx_date, "mengubah nota");
    const blockers = noteLineBlockers(d, Number(row.id));
    if (blockers.tally || blockers.recap || blockers.outgoing) throw new AppError(blockerMessage(blockers));
  }
  const oldLocation = String(rows[0].location || "").trim();
  if (oldLocation !== locationValue) {
    const moved = new Map();
    for (const row of rows) {
      const rowLocation = String(row.location || "").trim();
      if (rowLocation === locationValue) continue;
      const key = `${Number(row.product_id)}|${normalizeSize(row.trx_size)}|${rowLocation}`;
      moved.set(key, (moved.get(key) || 0) + Number(row.qty || 0));
    }
    for (const [key, totalMove] of moved.entries()) {
      const [productId, rowSize, rowLocation] = key.split("|");
      if (stockAt(d, Number(productId), rowSize, rowLocation) + EPS < totalMove) {
        throw new AppError(
          `Stok di lokasi ${rowLocation || "(tanpa lokasi)"} sudah terpakai atau termutasi. `
          + "Nota tidak dapat dipindahkan tanpa membuat stok minus.",
        );
      }
    }
  }
  if (targetNote !== oldNote) {
    const duplicate = d.where("transactions", (row) => Number(row.rit_id) === Number(ritId)
      && String((row.trx_number || "").trim()).toUpperCase() === targetNote.toUpperCase()
      && (row.trx_number || "") !== oldNote);
    if (duplicate) throw new AppError("Nomor nota tersebut sudah ada pada Rit ini.");
  }
  const timelineEntries = [];
  for (const row of rows) {
    const [lOld, , pOld] = sizeParts(row.trx_size);
    timelineEntries.push([row.product_id, row.trx_size, row.location]);
    timelineEntries.push([row.product_id, makeSize(tValue, lOld, pOld), locationValue]);
  }
  const verifyTimeline = guardTimeline(d, timelineEntries);
  let updated = 0;
  for (const row of rows) {
    const [lOld, , pOld] = sizeParts(row.trx_size);
    const newSize = makeSize(tValue, lOld, pOld);
    d.update("transactions", Number(row.id), {
      trx_date: targetDate, price: priceValue, location: locationValue,
      trx_size: newSize, trx_number: targetNote,
    });
    updated += 1;
  }
  verifyTimeline();
  upsertActivePrice(d, Number(rows[0].product_id), priceValue, d.now, userId);
  log(d, userId, "UBAH_NOTA",
    `rit=${ritId} | nota=${oldNote} → ${targetNote} | tanggal=${targetDate} | `
    + `tebal=${trimNumber(tValue)} | harga=${pyFloatStr(priceValue)} | lokasi=${locationValue} | baris=${updated}`,
    "seller_rits", Number(ritId));
  return { note: targetNote, updated };
}

export function deleteNoteLine(d, userId, trxId) {
  const row = d.where("transactions", (item) => Number(item.id) === Number(trxId) && item.trx_type === "MASUK");
  if (!row) throw new AppError("Baris nota tidak ditemukan.", 404);
  const product = d.one("products", Number(row.product_id)) || {};
  assertPeriodOpen(d, row.trx_date, "menghapus baris nota");
  const blockers = noteLineBlockers(d, Number(trxId));
  if (blockers.tally || blockers.recap || blockers.outgoing) throw new AppError(blockerMessage(blockers));
  const size = normalizeSize(row.trx_size);
  const available = stockAt(d, Number(row.product_id), size, row.location);
  if (available + EPS < Number(row.qty || 0)) {
    throw new AppError(
      "Stok di lokasi ini sudah terpakai atau termutasi sehingga baris nota tidak dapat dihapus.",
    );
  }
  const verifyTimeline = guardTimeline(d, [[row.product_id, size, row.location]]);
  d.delete("transactions", Number(trxId));
  verifyTimeline();
  log(d, userId, "HAPUS_BARIS_NOTA",
    `id=${trxId} | nota=${row.trx_number ?? null} | barang=${product.code} ${product.name} | `
    + `ukuran=${sizeDisplay(size)} | qty=${fmtQty(row.qty)}`,
    "transactions", Number(trxId));
  return { deleted: true };
}

/* ------------------------------------------------------------------ tally */

function newTallyNumber(d) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stampText = `${String(stamp.getFullYear()).slice(2)}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(2)))
      .map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const number = `TL-${stampText}-${hex}`;
    if (!d.where("tally_headers", (row) => row.tally_number === number)) return number;
  }
  throw new AppError("Tidak dapat membuat nomor tally unik.");
}

export function createTally(d, userId, ritId, note, items, signature) {
  const rit = ritRow(d, ritId);
  const cleanNote = String(note || "").trim();
  const cleanSignature = String(signature || "").trim();
  if (cleanSignature.length < 3) throw new AppError("Nama pemeriksa/tanda tangan wajib diisi (minimal 3 karakter).");
  if (cleanSignature.length > 100) throw new AppError("Nama pemeriksa maksimal 100 karakter.");
  if (!items || !items.length) throw new AppError("Pilih minimal satu baris untuk dibuat tally.");
  const sourceRows = d.filter("transactions", (row) => Number(row.rit_id) === Number(ritId)
    && row.trx_type === "MASUK" && (row.trx_number || "") === cleanNote);
  const byId = new Map(sourceRows.map((row) => [Number(row.id), row]));
  if (!byId.size) throw new AppError("Nota tidak ditemukan.", 404);
  const prepared = [];
  for (const item of items) {
    const trxId = Number(item?.trx_id);
    if (!Number.isFinite(trxId)) throw new AppError("Baris tally tidak valid.");
    const source = byId.get(trxId);
    if (!source) throw new AppError("Baris tally bukan bagian dari nota ini.");
    const duplicate = findPostedTallyForTrx(d, trxId);
    if (duplicate) throw new AppError(`Transaksi ini sudah dibuatkan Tally ${duplicate}.`);
    let qty = Number(item.qty !== undefined && item.qty !== null && item.qty !== "" ? item.qty : source.qty);
    if (!Number.isFinite(qty)) throw new AppError("Qty tally harus berupa angka.");
    if (qty <= 0) throw new AppError("Qty tally harus lebih dari 0.");
    if (qty > Number(source.qty) + EPS) {
      throw new AppError(`Qty tally melebihi qty barang masuk untuk ${source.trx_number}.`);
    }
    const kind = String(item.kind || "FRESH").toUpperCase();
    if (kind !== "FRESH" && kind !== "AFKIR") throw new AppError("Kategori tally harus FRESH atau AFKIR.");
    const price = kind === "FRESH" ? Number(source.price || 0) : 0;
    const volume = m3Value(source.trx_size, qty);
    const amount = pyRound2(volume * price);
    prepared.push({
      trx_id: trxId, product_id: Number(source.product_id), trx_size: normalizeSize(source.trx_size),
      qty, kind, price, volume, amount,
      note: String(item.note || "").trim().slice(0, 300),
    });
  }
  const number = newTallyNumber(d);
  const totalsQty = prepared.reduce((acc, item) => acc + item.qty, 0);
  const totalsVolume = prepared.reduce((acc, item) => acc + item.volume, 0);
  const totalsAmount = pyRound2(prepared.reduce((acc, item) => acc + item.amount, 0));
  const tallyId = d.allocate("tally_headers");
  d.insert("tally_headers", {
    id: tallyId,
    tally_number: number, rit_id: Number(ritId), seller_id: Number(rit.seller_id),
    note: cleanNote, delivery_number: rit.delivery_number ?? null, status: "POSTED",
    signature: cleanSignature, total_qty: totalsQty, total_volume: totalsVolume,
    total_amount: totalsAmount, created_by: userId ? Number(userId) : null,
    created_at: d.now, cancelled_at: null, cancel_note: null,
  });
  for (const item of prepared) {
    const itemId = d.allocate("tally_items");
    d.insert("tally_items", {
      id: itemId, tally_id: tallyId, trx_id: item.trx_id, product_id: item.product_id,
      trx_size: item.trx_size, qty: item.qty, kind: item.kind, price_m3: item.price,
      volume: item.volume, amount: item.amount, note: item.note,
    });
  }
  log(d, userId, "TALLY_SIMPAN",
    `${number} | rit=${ritId} | nota=${cleanNote} | item=${prepared.length} | `
    + `qty=${fmtQty(totalsQty)} | m3=${Number(totalsVolume).toFixed(6)} | total=${Number(totalsAmount).toFixed(2)} | pemeriksa=${cleanSignature}`,
    "tally_headers", tallyId);
  return { id: tallyId, tally_number: number, total_amount: totalsAmount };
}

function pyRound2(value) {
  return pyRound(value, 2);
}

function findPostedTallyForTrx(d, trxId) {
  for (const item of d.filter("tally_items", (row) => Number(row.trx_id) === Number(trxId))) {
    const header = d.one("tally_headers", Number(item.tally_id));
    if (header && header.status === "POSTED") return header.tally_number;
  }
  return null;
}

export function listTallies(d, sellerId = null, start = "", end = "", query = "", status = "") {
  let rows = d.all("tally_headers");
  if (sellerId !== null && sellerId !== undefined && sellerId !== "") {
    rows = rows.filter((row) => Number(row.seller_id) === Number(sellerId));
  }
  if (String(start || "").trim()) rows = rows.filter((row) => String(row.created_at).slice(0, 10) >= isoDate(start, "Tanggal dari"));
  if (String(end || "").trim()) rows = rows.filter((row) => String(row.created_at).slice(0, 10) <= isoDate(end, "Tanggal sampai"));
  if (String(status || "").trim()) rows = rows.filter((row) => row.status === String(status));
  const term = String(query || "").trim();
  if (term) {
    rows = rows.filter((row) => {
      const seller = row.seller_id ? d.one("sellers", Number(row.seller_id)) : null;
      return likeIncludes(term, row.tally_number, row.note, seller?.name, row.signature);
    });
  }
  rows = rows.slice().sort((a, b) => Number(b.id) - Number(a.id));
  return rows.map((row) => {
    const seller = row.seller_id ? d.one("sellers", Number(row.seller_id)) : null;
    const rit = row.rit_id ? d.one("seller_rits", Number(row.rit_id)) : null;
    const user = row.created_by ? d.one("users", Number(row.created_by)) : null;
    return {
      ...row,
      seller_name: seller?.name ?? null,
      rit_number: rit?.rit_number ?? null,
      rit_date: rit?.rit_date ?? null,
      username: user?.username ?? null,
      item_count: d.filter("tally_items", (item) => Number(item.tally_id) === Number(row.id)).length,
      rit_number_display: rit ? pad2(rit.rit_number) : "-",
      created_display: displayDate(String(row.created_at).slice(0, 10)),
    };
  });
}

function tallyLocked(d, header) {
  const items = d.filter("tally_items", (item) => Number(item.tally_id) === Number(header.id));
  const locked = lockedThrough(d);
  if (!locked) return false;
  return items.some((item) => {
    const trx = d.one("transactions", Number(item.trx_id));
    return trx && String(trx.trx_date).slice(0, 10) <= locked;
  });
}

export function getTally(d, tallyId) {
  const header = d.one("tally_headers", Number(tallyId));
  if (!header) throw new AppError("Tally tidak ditemukan.", 404);
  const seller = header.seller_id ? d.one("sellers", Number(header.seller_id)) : null;
  const rit = header.rit_id ? d.one("seller_rits", Number(header.rit_id)) : null;
  const user = header.created_by ? d.one("users", Number(header.created_by)) : null;
  const items = d.filter("tally_items", (item) => Number(item.tally_id) === Number(tallyId))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((item) => {
      const product = d.one("products", Number(item.product_id)) || {};
      const trx = d.one("transactions", Number(item.trx_id)) || {};
      return {
        ...item,
        code: product.code, name: product.name, unit: product.unit,
        trx_number: trx.trx_number ?? null, trx_date: trx.trx_date ?? null,
        trx_note: trx.note ?? null,
        size_display: sizeDisplay(item.trx_size),
        qty_display: fmtQty(item.qty),
      };
    });
  return {
    ...header,
    seller_name: seller?.name ?? null,
    rit_number: rit?.rit_number ?? null,
    rit_date: rit?.rit_date ?? null,
    rit_delivery: rit?.delivery_number ?? null,
    username: user?.username ?? null,
    items,
    rit_number_display: rit ? pad2(rit.rit_number) : "-",
    can_cancel: header.status === "POSTED" && !tallyLocked(d, header),
  };
}

export function cancelTally(d, userId, tallyId, reason = "") {
  const header = getTally(d, tallyId);
  if (header.status !== "POSTED") throw new AppError("Tally ini sudah dibatalkan.");
  if (tallyLocked(d, header)) throw new AppError("Tally berada pada periode yang sudah ditutup sehingga tidak dapat dibatalkan.");
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length > 300) throw new AppError("Alasan maksimal 300 karakter.");
  d.update("tally_headers", Number(tallyId), {
    status: "BATAL", cancelled_at: d.now, cancel_note: cleanReason,
  });
  log(d, userId, "TALLY_BATAL", `${header.tally_number} | alasan=${cleanReason || "-"}`, "tally_headers", Number(tallyId));
  return { cancelled: true };
}

/* ------------------------------------------------------- rekap pembayaran */

function newRecapNumber(d) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stampText = `${String(stamp.getFullYear()).slice(2)}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(2)))
      .map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const number = `RK-${stampText}-${hex}`;
    if (!d.where("payment_recap_headers", (row) => row.recap_number === number)) return number;
  }
  throw new AppError("Tidak dapat membuat nomor rekap unik.");
}

export function createRecap(d, userId, ritId, note) {
  const rit = ritRow(d, ritId);
  const cleanNote = String(note || "").trim();
  const products = new Map(d.all("products").map((row) => [Number(row.id), row]));
  const rows = d.filter("transactions", (row) => Number(row.rit_id) === Number(ritId)
    && row.trx_type === "MASUK" && (row.trx_number || "") === cleanNote)
    .map((row) => {
      const product = products.get(Number(row.product_id)) || {};
      return { ...row, code: product.code, name: product.name };
    });
  if (!rows.length) throw new AppError("Nota tidak ditemukan.", 404);
  const prepared = [];
  for (const row of rows) {
    assertPeriodOpen(d, row.trx_date, "membuat rekap pembayaran");
    const active = findActiveRecapForTrxWithDate(d, Number(row.id));
    if (active) {
      throw new AppError(
        `Transaksi ${row.trx_number || "-"} sudah masuk rekap aktif ${active.recap_number} `
        + `(${displayDate(String(active.created_at).slice(0, 10))}). Batalkan rekap lama terlebih dahulu.`,
      );
    }
    const volume = m3Value(row.trx_size, row.qty);
    const amount = pyRound2(volume * Number(row.price || 0));
    prepared.push({
      trx_id: Number(row.id), qty: Number(row.qty), size: normalizeSize(row.trx_size),
      price: Number(row.price || 0), volume, amount,
    });
  }
  const totalQty = prepared.reduce((acc, item) => acc + item.qty, 0);
  const totalVolume = prepared.reduce((acc, item) => acc + item.volume, 0);
  const totalAmount = pyRound2(prepared.reduce((acc, item) => acc + item.amount, 0));
  const number = newRecapNumber(d);
  const recapId = d.allocate("payment_recap_headers");
  d.insert("payment_recap_headers", {
    id: recapId,
    recap_number: number, seller_id: Number(rit.seller_id), rit_id: Number(ritId),
    note: cleanNote, total_qty: totalQty, total_volume: totalVolume, total_amount: totalAmount,
    status: "AKTIF", created_by: userId ? Number(userId) : null, created_at: d.now,
    cancelled_at: null, cancel_note: null,
  });
  for (const item of prepared) {
    const itemId = d.allocate("payment_recap_items");
    d.insert("payment_recap_items", {
      id: itemId, recap_id: recapId, trx_id: item.trx_id, active: 1,
      qty: item.qty, trx_size: item.size, price: item.price, volume: item.volume, amount: item.amount,
    });
  }
  log(d, userId, "REKAP_PEMBAYARAN",
    `${number} | rit=${ritId} | nota=${cleanNote} | item=${prepared.length} | `
    + `qty=${fmtQty(totalQty)} | total=${Number(totalAmount).toFixed(2)}`,
    "payment_recap_headers", recapId);
  return { id: recapId, recap_number: number, total_amount: totalAmount };
}

function findActiveRecapForTrxWithDate(d, trxId) {
  for (const item of d.filter("payment_recap_items", (row) => Number(row.trx_id) === Number(trxId) && row.active === 1)) {
    const header = d.one("payment_recap_headers", Number(item.recap_id));
    if (header && header.status === "AKTIF") {
      return { recap_number: header.recap_number, created_at: header.created_at };
    }
  }
  return null;
}

export function listRecaps(d, sellerId = null, start = "", end = "", query = "", status = "") {
  let rows = d.all("payment_recap_headers");
  if (sellerId !== null && sellerId !== undefined && sellerId !== "") {
    rows = rows.filter((row) => Number(row.seller_id) === Number(sellerId));
  }
  if (String(start || "").trim()) rows = rows.filter((row) => String(row.created_at).slice(0, 10) >= isoDate(start, "Tanggal dari"));
  if (String(end || "").trim()) rows = rows.filter((row) => String(row.created_at).slice(0, 10) <= isoDate(end, "Tanggal sampai"));
  if (String(status || "").trim()) rows = rows.filter((row) => row.status === String(status));
  const term = String(query || "").trim();
  if (term) {
    rows = rows.filter((row) => {
      const seller = row.seller_id ? d.one("sellers", Number(row.seller_id)) : null;
      return likeIncludes(term, row.recap_number, row.note, seller?.name);
    });
  }
  rows = rows.slice().sort((a, b) => Number(b.id) - Number(a.id));
  return rows.map((row) => {
    const seller = row.seller_id ? d.one("sellers", Number(row.seller_id)) : null;
    const rit = row.rit_id ? d.one("seller_rits", Number(row.rit_id)) : null;
    const user = row.created_by ? d.one("users", Number(row.created_by)) : null;
    return {
      ...row,
      seller_name: seller?.name ?? null,
      rit_number: rit?.rit_number ?? null,
      username: user?.username ?? null,
      item_count: d.filter("payment_recap_items", (item) => Number(item.recap_id) === Number(row.id) && item.active === 1).length,
      rit_number_display: rit ? pad2(rit.rit_number) : "-",
    };
  });
}

export function getRecap(d, recapId) {
  const header = d.one("payment_recap_headers", Number(recapId));
  if (!header) throw new AppError("Rekap pembayaran tidak ditemukan.", 404);
  const seller = header.seller_id ? d.one("sellers", Number(header.seller_id)) : null;
  const rit = header.rit_id ? d.one("seller_rits", Number(header.rit_id)) : null;
  const user = header.created_by ? d.one("users", Number(header.created_by)) : null;
  const items = d.filter("payment_recap_items", (item) => Number(item.recap_id) === Number(recapId))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((item) => {
      const trx = d.one("transactions", Number(item.trx_id)) || {};
      const product = trx.product_id ? d.one("products", Number(trx.product_id)) || {} : {};
      return {
        ...item,
        code: product.code, name: product.name, unit: product.unit,
        trx_date: trx.trx_date ?? null, trx_number: trx.trx_number ?? null,
        delivery_number: trx.delivery_number ?? null, supplier: trx.supplier ?? null,
        size_display: sizeDisplay(item.trx_size),
        qty_display: fmtQty(item.qty),
      };
    });
  const locked = lockedThrough(d);
  return {
    ...header,
    seller_name: seller?.name ?? null,
    rit_number: rit?.rit_number ?? null,
    rit_date: rit?.rit_date ?? null,
    username: user?.username ?? null,
    items,
    rit_number_display: rit ? pad2(rit.rit_number) : "-",
    can_cancel: header.status === "AKTIF" && !(
      locked && items.some((item) => String(item.trx_date || "").slice(0, 10) <= locked)
    ),
  };
}

export function cancelRecap(d, userId, recapId, reason = "") {
  const header = getRecap(d, recapId);
  if (header.status !== "AKTIF") throw new AppError("Rekap pembayaran ini sudah dibatalkan.");
  const locked = lockedThrough(d);
  for (const item of header.items) {
    if (locked && String(item.trx_date || "").slice(0, 10) <= locked) {
      throw new AppError("Rekap pembayaran berada pada periode yang sudah ditutup sehingga tidak dapat dibatalkan.");
    }
  }
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length > 300) throw new AppError("Alasan maksimal 300 karakter.");
  d.update("payment_recap_headers", Number(recapId), {
    status: "BATAL", cancelled_at: d.now, cancel_note: cleanReason,
  });
  for (const item of d.filter("payment_recap_items", (row) => Number(row.recap_id) === Number(recapId))) {
    d.update("payment_recap_items", item.id, { active: 0 });
  }
  log(d, userId, "BATAL_REKAP_PEMBAYARAN", `${header.recap_number} | alasan=${cleanReason || "-"}`, "payment_recap_headers", Number(recapId));
  return { cancelled: true };
}

export function sellerDirectory(d) {
  const rows = d.all("sellers")
    .slice()
    .sort((a, b) => (Number(b.active) - Number(a.active)) || nocase(a.name, b.name));
  return rows.map((row) => {
    const trx = d.filter("transactions", (item) => Number(item.seller_id) === Number(row.id));
    const masuk = trx.filter((item) => item.trx_type === "MASUK");
    const keluar = trx.filter((item) => item.trx_type === "KELUAR");
    const rits = d.filter("seller_rits", (item) => Number(item.seller_id) === Number(row.id)).length;
    const lastTrx = trx.reduce((acc, item) => (!acc || item.trx_date > acc ? item.trx_date : acc), null);
    const qtyIn = masuk.reduce((acc, item) => acc + Number(item.qty || 0), 0);
    const qtyOut = keluar.reduce((acc, item) => acc + Number(item.qty || 0), 0);
    return {
      ...row,
      rit_count: rits,
      line_count: masuk.length,
      qty_in: qtyIn,
      qty_out: qtyOut,
      last_trx: lastTrx,
      qty_in_display: fmtQty(qtyIn),
      qty_out_display: fmtQty(qtyOut),
    };
  });
}

/* --------------------------------------------------- penerimaan kayu impor */

const ALIASES = {
  barcode: ["barcode", "bar_code", "kode_barcode", "code", "id"],
  product_code: ["product_code", "kode_barang", "kode", "sku", "item_code"],
  product_name: ["product_name", "nama_barang", "nama", "item", "product", "species", "jenis_kayu"],
  size: ["size", "ukuran", "dimension", "dimensi"],
  length: ["length", "panjang", "p"],
  width: ["width", "lebar", "l"],
  thickness: ["thickness", "tebal", "t"],
  qty: ["qty", "quantity", "jumlah", "batang"],
  supplier: ["supplier", "pemasok", "exporter", "asal", "country", "negara_asal"],
  number: ["number", "document", "no_dokumen", "invoice", "invoice_no"],
  date: ["date", "tanggal"],
  location: ["location", "lokasi", "warehouse", "gudang"],
  price: ["price", "harga", "harga_m3", "price_m3"],
  note: ["note", "catatan"],
};

export function parsePayload(payload) {
  let raw = "";
  const data = {};
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || value === undefined) continue;
      data[String(key).trim().toLowerCase()] = String(value).trim();
    }
    raw = JSON.stringify(payload);
  } else {
    raw = String(payload || "").trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [key, value] of Object.entries(obj)) {
          if (value === null || value === undefined) continue;
          data[String(key).trim().toLowerCase()] = String(value).trim();
        }
      }
    } catch {
      /* bukan JSON: lanjut pola KEY=VALUE */
    }
    if (!Object.keys(data).length) {
      for (const part of raw.split(/[|;\n]+/)) {
        if (part.includes("=")) {
          const [key, ...rest] = part.split("=");
          data[key.trim().toLowerCase()] = rest.join("=").trim();
        } else if (part.includes(":")) {
          const [key, ...rest] = part.split(":");
          data[key.trim().toLowerCase()] = rest.join(":").trim();
        }
      }
    }
  }
  const out = { raw };
  for (const [target, keys] of Object.entries(ALIASES)) {
    for (const key of keys) {
      if (key in data && String(data[key]).trim()) {
        out[target] = String(data[key]).trim();
        break;
      }
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function parseImportDate(value) {
  let text = String(value || "").trim();
  if (!text) text = new Date().toLocaleDateString("id-ID");
  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})$/,
    /^(\d{2})-(\d{2})-(\d{4})$/,
    /^(\d{2})\/(\d{2})\/(\d{4})$/,
    /^(\d{4})\/(\d{2})\/(\d{2})$/,
  ];
  for (let i = 0; i < formats.length; i += 1) {
    const match = formats[i].exec(text.slice(0, 10));
    if (!match) continue;
    let year, month, day;
    if (i === 0) [year, month, day] = [match[1], match[2], match[3]];
    else if (i === 1) [year, month, day] = [match[3], match[2], match[1]];
    else if (i === 2) [year, month, day] = [match[3], match[2], match[1]];
    else [year, month, day] = [match[1], match[2], match[3]];
    const iso = `${year}-${month}-${day}`;
    try {
      parseISODate(iso);
      return iso;
    } catch {
      continue;
    }
  }
  throw new AppError("Tanggal tidak valid. Gunakan format DD-MM-YYYY.");
}

function positiveNumber(value, label, allowZero = false) {
  const number = Number(String(value).replace(",", ".").replace("Rp", "").trim());
  if (!Number.isFinite(number) || number < 0 || (number === 0 && !allowZero)) {
    throw new AppError(`${label} harus ${allowZero ? "nol atau lebih" : "lebih dari nol"}.`);
  }
  return number;
}

function priceValue(value) {
  let text = String(value || "0").trim().replace("Rp", "").replace(/\s+/g, "");
  if (!text) return 0;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
  else text = text.replace(",", ".");
  return positiveNumber(text, "Harga per m³", true);
}

function importDimensions(data) {
  const thickness = data.thickness;
  const width = data.width;
  const length = data.length;
  if (String(thickness || "").trim() || String(width || "").trim() || String(length || "").trim()) {
    const values = [];
    for (const [label, raw] of [["Tebal", thickness], ["Lebar", width], ["Panjang", length]]) {
      const text = String(raw || "").trim();
      if (!/^\d{1,4}$/.test(text) || Number(text) <= 0) {
        throw new AppError(`Ukuran ${label} harus angka positif maksimal 4 digit.`);
      }
      values.push(Number(text));
    }
    return makeSize(values[0], values[1], values[2]);
  }
  const rawSize = String(data.size || "").trim();
  if (!rawSize) throw new AppError("Ukuran (T, L, P) wajib diisi.");
  let normalized;
  try {
    normalized = normalizeSize(rawSize);
  } catch (error) {
    throw new AppError("Ukuran tidak valid. Gunakan format T×L×P atau T, L, P.");
  }
  if (!normalized) throw new AppError("Ukuran wajib diisi.");
  return normalized;
}

function splitNote(note) {
  const text = String(note || "");
  const match = /BARCODE=([^;]*);\s*/.exec(text);
  let barcode = "";
  let rest = text.trim();
  if (match) {
    barcode = match[1].trim();
    rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  }
  const prefix = "Penerimaan impor.";
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length).trim();
  return [barcode, rest];
}

function importNumber(d, number, barcode) {
  const stem = String(number || barcode || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 35);
  const trxNumber = "IMP-" + (stem || randomHex(6));
  if (d.where("transactions", (row) => row.trx_number === trxNumber)) {
    throw new AppError("Nomor penerimaan impor sudah pernah digunakan. Periksa barcode atau nomor dokumen.");
  }
  return trxNumber;
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prepareImport(d, data) {
  const name = String(data.product_name || data.product || data.product_code || "").trim().toUpperCase();
  if (!name) throw new AppError("Nama barang wajib diisi.");
  if (name.length > 120) throw new AppError("Nama barang maksimal 120 karakter.");
  const trxDate = parseImportDate(data.date);
  if (trxDate > todayISO()) throw new AppError("Tanggal penerimaan tidak boleh melewati hari ini.");
  assertPeriodOpen(d, trxDate, "menyimpan penerimaan impor");
  const size = importDimensions(data);
  const qty = positiveNumber(data.qty, "Jumlah batang");
  if (qty > 1000000) throw new AppError("Jumlah batang tidak wajar.");
  const price = priceValue(data.price);
  let location = String(data.location || "").trim();
  if (!location) throw new AppError("Lokasi gudang wajib diisi.");
  location = resolveLocation(d, location);
  const barcode = String(data.barcode || "").trim().slice(0, 120);
  const number = String(data.number || "").trim().slice(0, 80);
  const supplier = String(data.supplier || "").trim().slice(0, 120);
  const note = String(data.note || "").trim().slice(0, 300);
  return { name, trx_date: trxDate, size, qty, price, location, barcode, number, supplier, note };
}

function ensureProduct(d, name) {
  const slug = (String(name).replace(/[^A-Za-z0-9]/g, "").slice(0, 18)) || "ITEM";
  let code = `IMP/${slug}`;
  let counter = 1;
  for (;;) {
    const existing = d.where("products", (row) => String(row.code).toLowerCase() === code.toLowerCase());
    if (!existing) {
      const productId = d.allocate("products");
      d.insert("products", {
        id: productId, code, name, unit: "BATANG", purchase_price: 0,
        spec_t: null, spec_l: null, spec_p: null, min_stock: 0,
        active: 1, created_at: d.now,
      });
      return d.one("products", productId);
    }
    if (String(existing.name || "").trim().toUpperCase() === name) return existing;
    counter += 1;
    code = `IMP/${slug}${counter}`;
  }
}

export function createImport(d, userId, payload) {
  const data = payload && typeof payload === "object" && !Array.isArray(payload) && !("parsed" in payload)
    ? payload
    : parsePayload(payload);
  const prepared = prepareImport(d, data);
  const product = ensureProduct(d, prepared.name);
  const trxNumber = importNumber(d, prepared.number, prepared.barcode);
  const noteParts = [];
  if (prepared.barcode) noteParts.push(`BARCODE=${prepared.barcode};`);
  noteParts.push("Penerimaan impor.");
  if (prepared.note) noteParts.push(prepared.note);
  const noteText = noteParts.join(" ");
  const trxId = d.allocate("transactions");
  d.insert("transactions", {
    id: trxId,
    trx_date: prepared.trx_date, trx_type: "MASUK", product_id: Number(product.id),
    qty: prepared.qty, price: prepared.price, note: noteText,
    trx_size: prepared.size, location: prepared.location,
    seller_id: null, rit_id: null, source_trx_id: null,
    trx_number: trxNumber, delivery_number: prepared.number || null,
    supplier: prepared.supplier, user_id: userId ? Number(userId) : null, created_at: d.now,
  });
  log(d, userId, "PENERIMAAN_IMPOR",
    `${trxNumber} | produk=${product.code} ${product.name} | ukuran=${sizeDisplay(prepared.size)} | `
    + `qty=${fmtQty(prepared.qty)} | lokasi=${prepared.location} | pemasok=${prepared.supplier || "-"}`,
    "transactions", trxId);
  return getImport(d, trxId);
}

export function listImports(d, start = "", end = "", query = "") {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const from = String(start || "").trim()
    ? isoDate(start, "Tanggal dari")
    : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const to = String(end || "").trim() ? isoDate(end, "Tanggal sampai") : todayISO();
  if (from > to) throw new AppError("Tanggal dari tidak boleh melewati tanggal sampai.");
  const users = new Map(d.all("users").map((row) => [Number(row.id), row]));
  let rows = d.filter("transactions", (row) => row.trx_type === "MASUK"
    && String(row.trx_number || "").startsWith("IMP-")
    && row.trx_date >= from && row.trx_date <= to);
  const term = String(query || "").trim();
  if (term) {
    rows = rows.filter((row) => {
      const product = d.one("products", Number(row.product_id)) || {};
      return likeIncludes(term, row.trx_number, row.delivery_number, product.code, product.name, row.supplier, row.note, row.location);
    });
  }
  rows = rows.slice().sort((a, b) => (a.trx_date < b.trx_date ? 1 : a.trx_date > b.trx_date ? -1 : Number(b.id) - Number(a.id)));
  let totalQty = 0;
  let totalM3 = 0;
  let totalAmount = 0;
  const result = rows.map((row) => {
    const product = d.one("products", Number(row.product_id)) || {};
    const [barcode] = splitNote(row.note || "");
    const size = normalizeSize(row.trx_size);
    const volume = m3Value(size, row.qty);
    totalQty += Number(row.qty || 0);
    totalM3 += volume;
    totalAmount += volume * Number(row.price || 0);
    return {
      id: row.id, trx_date: row.trx_date, trx_number: row.trx_number, qty: row.qty,
      price: row.price, note: row.note, trx_size: row.trx_size, location: row.location,
      supplier: row.supplier, delivery_number: row.delivery_number, created_at: row.created_at,
      code: product.code, name: product.name,
      username: users.get(Number(row.user_id))?.username ?? null,
      barcode,
      document_number: row.delivery_number || "",
      size, size_display: sizeDisplay(size), qty_display: fmtQty(row.qty),
      date_display: displayDate(String(row.trx_date).slice(0, 10)),
      m3: pyRound(volume, 6),
      amount: pyRound(volume * Number(row.price || 0), 2),
    };
  });
  return {
    start: from, end: to,
    start_display: displayDate(from), end_display: displayDate(to),
    rows: result,
    totals: {
      count: result.length, qty: pyRound(totalQty, 4),
      m3: pyRound(totalM3, 6), amount: pyRound(totalAmount, 2),
    },
  };
}

export function getImport(d, trxId) {
  const row = d.where("transactions", (item) => Number(item.id) === Number(trxId)
    && item.trx_type === "MASUK" && String(item.trx_number || "").startsWith("IMP-"));
  if (!row) throw new AppError("Penerimaan impor tidak ditemukan.", 404);
  const product = d.one("products", Number(row.product_id)) || {};
  const user = row.user_id ? d.one("users", Number(row.user_id)) : null;
  const [barcode, note] = splitNote(row.note || "");
  const size = normalizeSize(row.trx_size);
  const volume = pyRound(m3Value(size, row.qty), 6);
  const used = pyRound(d.filter("transactions", (item) => Number(item.source_trx_id) === Number(trxId) && item.trx_type === "KELUAR")
    .reduce((acc, item) => acc + Number(item.qty || 0), 0), 4);
  return {
    ...row,
    code: product.code, name: product.name, unit: product.unit,
    username: user?.username ?? null,
    barcode, user_note: note,
    size, size_display: sizeDisplay(size),
    volume, amount: pyRound(volume * Number(row.price || 0), 2),
    date_display: displayDate(String(row.trx_date).slice(0, 10)),
    used, can_edit: true,
  };
}

export function updateImport(d, userId, trxId, payload) {
  const current = getImport(d, trxId);
  const data = { ...(payload || {}) };
  const trxDate = parseImportDate(data.date !== undefined ? data.date : current.trx_date);
  if (trxDate > todayISO()) throw new AppError("Tanggal penerimaan tidak boleh melewati hari ini.");
  assertPeriodOpen(d, current.trx_date, "mengubah penerimaan impor");
  assertPeriodOpen(d, trxDate, "mengubah penerimaan impor");
  const qty = positiveNumber(data.qty !== undefined ? data.qty : current.qty, "Jumlah batang");
  if (qty + 0.0001 < Number(current.used)) {
    throw new AppError(`Qty tidak boleh lebih kecil dari barang keluar yang sudah memakai lot ini (${fmtQty(current.used)}).`);
  }
  const price = priceValue(data.price !== undefined ? data.price : current.price);
  const supplier = String(data.supplier !== undefined ? data.supplier : (current.supplier ?? "") || "").trim().slice(0, 120);
  const note = String(data.note !== undefined ? data.note : (current.user_note ?? "") || "").trim().slice(0, 300);
  const barcode = String(data.barcode !== undefined ? data.barcode : (current.barcode ?? "") || "").trim().slice(0, 120);
  const noteParts = [];
  if (barcode) noteParts.push(`BARCODE=${barcode};`);
  noteParts.push("Penerimaan impor.");
  if (note) noteParts.push(note);
  d.update("transactions", Number(trxId), {
    trx_date: trxDate, qty, price, supplier, note: noteParts.join(" "),
  });
  log(d, userId, "UBAH_PENERIMAAN_IMPOR",
    `${current.trx_number} | qty ${fmtQty(current.qty)} -> ${fmtQty(qty)} | `
    + `tgl ${current.trx_date} -> ${trxDate} | harga=${pyG(price)}`,
    "transactions", Number(trxId));
  return getImport(d, trxId);
}
