/* Port server/admin.py + server/auth.py + server/seed.py: pengguna, master
   data, backup/reset, status sinkronisasi, akun awal, dan pembersihan data
   demo peninggalan versi sebelumnya. */

import {
  AppError, DEVELOPER_USERNAME, PRODUCT_UNITS, IMPORT_PREFIX,
  checkNewPassword, hashPassword, todayISO, verifyPassword, pyG,
} from "./core.js";
import { log, nocase, generateNameCode } from "./flow.js";

export function isImportCode(code) {
  return String(code || "").trim().toUpperCase().startsWith(IMPORT_PREFIX);
}

export function requireAdmin(user) {
  if (!user || user.role !== "admin" || !user.active) {
    throw new AppError("Akses ditolak. Tindakan ini khusus administrator.", { status: 403, code: "FORBIDDEN" });
  }
  return user;
}

export function requirePrimary(user) {
  requireAdmin(user);
  if (!user.is_primary_admin) {
    throw new AppError(
      "Akses ditolak. Perubahan status data master hanya dapat dilakukan Admin Utama.",
      { status: 403, code: "PRIMARY_REQUIRED" },
    );
  }
  return user;
}

function text(value, label, required = false, maxLen = 180) {
  const clean = String(value ?? "").trim();
  if (required && !clean) throw new AppError(`${label} wajib diisi.`);
  if (clean.length > maxLen) throw new AppError(`${label} maksimal ${maxLen} karakter.`);
  return clean;
}

function number(value, label, minimum = 0, allowBlank = false) {
  if ((value === null || value === undefined || value === "") && allowBlank) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AppError(`${label} harus berupa angka.`);
  if (parsed < minimum) throw new AppError(`${label} minimal ${trimNumberFromG(minimum)}.`);
  return parsed;
}

function flag(value, defaultValue = true) {
  if (value === null || value === undefined) return defaultValue ? 1 : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  return ["1", "true", "ya", "aktif", "active", "on"].includes(String(value).trim().toLowerCase()) ? 1 : 0;
}

/* ------------------------------------------------------------------ produk */

function defaultSizeDisplay(row) {
  const specs = [row.spec_t, row.spec_l, row.spec_p];
  if (specs.every((value) => value !== null && value !== undefined && value !== "")) {
    return specs.map((value) => trimNumberFromG(value)).join(" × ");
  }
  return "-";
}

function trimNumberFromG(value) {
  const num = Number(value);
  if (Number.isInteger(num)) return String(num);
  return trimNumber(num);
}

export function listProducts(d, { includeInactive = true, localOnly = false, query = "" } = {}) {
  let rows = d.all("products");
  if (!includeInactive) rows = rows.filter((row) => row.active === 1);
  if (localOnly) rows = rows.filter((row) => row.active === 1 && !String(row.code).startsWith("IMP/"));
  const term = String(query || "").trim();
  if (term) {
    rows = rows.filter((row) => String(row.code).toLowerCase().includes(term.toLowerCase())
      || String(row.name).toLowerCase().includes(term.toLowerCase()));
  }
  rows = rows.slice().sort((a, b) => nocase(a.name, b.name) || nocase(a.code, b.code));
  return rows.map((row) => {
    const price = d.where("product_active_prices", (item) => Number(item.product_id) === Number(row.id));
    return {
      ...row,
      active_price: price ? Number(price.active_price) : 0,
      price_updated_at: price?.updated_at ?? null,
      is_import: isImportCode(row.code),
      size_default_display: defaultSizeDisplay(row),
    };
  });
}

export function getProduct(d, productId) {
  const row = d.one("products", Number(productId));
  if (!row) throw new AppError("Barang tidak ditemukan.", 404);
  const price = d.where("product_active_prices", (item) => Number(item.product_id) === Number(productId));
  return {
    ...row,
    active_price: price ? Number(price.active_price) : 0,
    is_import: isImportCode(row.code),
  };
}

function checkActiveSpec(d, dimension, value, label) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = number(value, label);
  const row = d.where("master_spec_values", (item) => item.dimension === dimension
    && Number(item.value) === Number(parsed) && item.active === 1);
  if (!row) throw new AppError(`${label} ${trimNumberFromG(parsed)} tidak ada pada master ukuran aktif.`);
  return parsed;
}

function checkActivePrice(d, value) {
  const price = number(value, "Harga aktif", 0);
  if (price === 0) return 0;
  const row = d.where("master_price_values", (item) => Number(item.price) === Number(price) && item.active === 1);
  if (!row) {
    throw new AppError(`Harga ${groupDigits(price)} tidak ada pada master harga aktif.`);
  }
  return price;
}

function groupDigits(value) {
  return String(Math.round(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function prepareProduct(d, payload, current = null) {
  const name = text(payload.name ?? current?.name, "Nama barang", true, 120);
  let code = text(payload.code ?? current?.code, "Kode barang", false, 40).toUpperCase();
  if (current && isImportCode(current.code)) code = current.code;
  else if (code && isImportCode(code)) {
    throw new AppError("Kode dengan awalan IMP/ khusus barang hasil impor dan tidak dapat dibuat manual.");
  }
  if (current === null && !code) code = generateNameCode(d, name);
  if (current && current.code && code !== current.code) {
    const used = d.filter("transactions", (row) => Number(row.product_id) === Number(current.id)).length
      + d.filter("stock_opname_items", (row) => Number(row.product_id) === Number(current.id)).length;
    if (used > 0) throw new AppError("Kode barang tidak dapat diubah karena sudah dipakai transaksi/opname.");
  }
  const unit = text(payload.unit ?? current?.unit ?? "BATANG", "Satuan", true, 20).toUpperCase();
  if (!PRODUCT_UNITS.includes(unit)) throw new AppError("Satuan harus salah satu dari: " + PRODUCT_UNITS.join(", ") + ".");
  const purchasePrice = number(payload.purchase_price ?? current?.purchase_price ?? 0, "Harga beli acuan");
  const specT = checkActiveSpec(d, "T", payload.spec_t !== undefined ? payload.spec_t : current?.spec_t, "Tebal default");
  const specL = checkActiveSpec(d, "L", payload.spec_l !== undefined ? payload.spec_l : current?.spec_l, "Lebar default");
  const specP = checkActiveSpec(d, "P", payload.spec_p !== undefined ? payload.spec_p : current?.spec_p, "Panjang default");
  const minStock = number(payload.min_stock !== undefined ? payload.min_stock : current?.min_stock ?? 0, "Stok minimum");
  let activePrice = payload.active_price;
  if (activePrice === undefined || activePrice === null) activePrice = current?.active_price ?? 0;
  activePrice = checkActivePrice(d, activePrice);
  return { name, code, unit, purchase_price: purchasePrice, spec_t: specT, spec_l: specL, spec_p: specP, min_stock: minStock, active_price: activePrice };
}

export function createProduct(d, userId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const prepared = prepareProduct(d, payload || {});
  const productId = d.allocate("products");
  const existing = d.where("products", (row) => String(row.code).toLowerCase() === prepared.code.toLowerCase());
  if (existing) throw new AppError("Kode barang sudah dipakai. Gunakan kode lain.");
  d.insert("products", {
    id: productId, code: prepared.code, name: prepared.name, unit: prepared.unit,
    purchase_price: prepared.purchase_price, spec_t: prepared.spec_t, spec_l: prepared.spec_l,
    spec_p: prepared.spec_p, min_stock: prepared.min_stock, active: 1, created_at: d.now,
  });
  if (prepared.active_price > 0) {
    d.insert("product_active_prices", {
      id: productId, product_id: productId, active_price: prepared.active_price,
      updated_at: d.now, updated_by: Number(userId),
    });
  }
  log(d, userId, "TAMBAH_BARANG",
    `${prepared.code} | ${prepared.name} | satuan=${prepared.unit} | harga=${pyG(prepared.active_price)}`,
    "products", productId);
  return getProduct(d, productId);
}

export function updateProduct(d, userId, productId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const current = getProduct(d, productId);
  const prepared = prepareProduct(d, payload || {}, current);
  const conflict = d.where("products", (row) => String(row.code).toLowerCase() === prepared.code.toLowerCase()
    && Number(row.id) !== Number(productId));
  if (conflict) throw new AppError("Kode barang sudah dipakai. Gunakan kode lain.");
  d.update("products", Number(productId), {
    code: prepared.code, name: prepared.name, unit: prepared.unit,
    purchase_price: prepared.purchase_price, spec_t: prepared.spec_t,
    spec_l: prepared.spec_l, spec_p: prepared.spec_p, min_stock: prepared.min_stock,
  });
  if (prepared.active_price !== Number(current.active_price || 0)) {
    upsertPrice(d, Number(productId), prepared.active_price, userId);
  }
  log(d, userId, "UBAH_BARANG",
    `${prepared.code} | ${prepared.name} | harga aktif=${pyG(prepared.active_price)}`,
    "products", Number(productId));
  return getProduct(d, productId);
}

function upsertPrice(d, productId, activePrice, userId = null) {
  const existing = d.where("product_active_prices", (row) => Number(row.product_id) === productId);
  if (existing) {
    d.update("product_active_prices", existing.id, {
      active_price: activePrice, updated_at: d.now, updated_by: userId ? Number(userId) : null,
    });
  } else {
    d.insert("product_active_prices", {
      id: productId, product_id: productId, active_price: activePrice,
      updated_at: d.now, updated_by: userId ? Number(userId) : null,
    });
  }
}

export function toggleProduct(d, userId, productId) {
  const user = requirePrimary(currentUserRow(d, userId));
  const product = getProduct(d, productId);
  const target = product.active ? 0 : 1;
  d.update("products", Number(productId), { active: target });
  log(d, userId, "STATUS_BARANG",
    `${product.code} | ${product.name} | status=${target ? "AKTIF" : "NONAKTIF"}`,
    "products", Number(productId));
  return { active: Boolean(target) };
}

/* ------------------------------------------------------------------ penjual */

/** Samakan field name/seller agar data dari edisi 01 (field `seller`)
 *  dan edisi 02 (field `name`) tampil sama. */
function normalizeSellerRow(row) {
  if (!row) return row;
  const name = String(row.name || row.seller || row.base_name || "").trim();
  return {
    ...row,
    name,
    seller: row.seller || name,
    active: row.active === 0 || row.active === false ? 0 : 1,
  };
}

export function listSellers(d, { includeInactive = true, query = "" } = {}) {
  let rows = d.all("sellers").map(normalizeSellerRow);
  if (!includeInactive) rows = rows.filter((row) => row.active === 1);
  const term = String(query || "").trim();
  if (term) {
    rows = rows.filter((row) => likeTerm(term, row.name, row.seller, row.city, row.phone));
  }
  rows = rows.slice().sort((a, b) => nocase(a.name, b.name));
  return rows.map((row) => ({
    ...row,
    rit_count: d.filter("seller_rits", (item) => String(item.seller_id) === String(row.id)
      || String(item.seller || "").toLowerCase() === String(row.name || "").toLowerCase()).length,
    transaction_count: d.filter("transactions", (item) => String(item.seller_id) === String(row.id)
      || String(item.supplier || "").toLowerCase() === String(row.name || "").toLowerCase()).length,
  }));
}

function likeTerm(term, ...fields) {
  const needle = String(term || "").toLowerCase();
  return fields.some((field) => String(field ?? "").toLowerCase().includes(needle));
}

export function createSeller(d, userId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const name = text(payload.name, "Nama penjual", true, 120);
  const city = text(payload.city, "Kota", false, 80);
  const phone = text(payload.phone, "Telepon", false, 40);
  const address = text(payload.address, "Alamat", false, 240);
  const note = text(payload.note, "Catatan", false, 240);
  const duplicate = d.where("sellers", (row) => {
    const n = String(row.name || row.seller || "").toLowerCase();
    return n === name.toLowerCase();
  });
  if (duplicate) throw new AppError("Nama penjual sudah terdaftar.");
  const sellerId = d.allocate("sellers");
  // name (02) + seller (01) diisi sama agar data bersama
  d.insert("sellers", {
    id: sellerId, name, seller: name, city, phone, address, note, active: 1, created_at: d.now,
  });
  log(d, userId, "TAMBAH_PENJUAL", `${name} | ${city}`, "sellers", sellerId);
  return normalizeSellerRow(d.one("sellers", sellerId));
}

export function updateSeller(d, userId, sellerId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const id = /^\d+$/.test(String(sellerId)) ? Number(sellerId) : sellerId;
  const current = d.one("sellers", id);
  if (!current) throw new AppError("Penjual tidak ditemukan.", 404);
  const name = text(payload.name ?? current.name ?? current.seller, "Nama penjual", true, 120);
  const city = text(payload.city ?? current.city, "Kota", false, 80);
  const phone = text(payload.phone ?? current.phone, "Telepon", false, 40);
  const address = text(payload.address ?? current.address, "Alamat", false, 240);
  const note = text(payload.note ?? current.note, "Catatan", false, 240);
  const duplicate = d.where("sellers", (row) => {
    const n = String(row.name || row.seller || "").toLowerCase();
    return n === name.toLowerCase() && String(row.id) !== String(current.id);
  });
  if (duplicate) throw new AppError("Nama penjual sudah terdaftar.");
  d.update("sellers", current.id, { name, seller: name, city, phone, address, note });
  log(d, userId, "UBAH_PENJUAL", `${name} | ${city}`, "sellers", current.id);
  return normalizeSellerRow(d.one("sellers", current.id));
}

export function toggleSeller(d, userId, sellerId) {
  requirePrimary(currentUserRow(d, userId));
  const id = /^\d+$/.test(String(sellerId)) ? Number(sellerId) : sellerId;
  const seller = d.one("sellers", id);
  if (!seller) throw new AppError("Penjual tidak ditemukan.", 404);
  const target = seller.active ? 0 : 1;
  d.update("sellers", seller.id, { active: target });
  log(d, userId, "STATUS_PENJUAL", `${seller.name || seller.seller} | status=${target ? "AKTIF" : "NONAKTIF"}`, "sellers", seller.id);
  return { active: Boolean(target) };
}

export function deleteSeller(d, userId, sellerId) {
  requireAdmin(currentUserRow(d, userId));
  const id = /^\d+$/.test(String(sellerId)) ? Number(sellerId) : sellerId;
  const seller = d.one("sellers", id);
  if (!seller) throw new AppError("Penjual tidak ditemukan.", 404);
  const used = d.filter("seller_rits", (row) => String(row.seller_id) === String(seller.id)).length
    + d.filter("transactions", (row) => String(row.seller_id) === String(seller.id)).length;
  if (used > 0) throw new AppError("Penjual sudah memiliki rit/transaksi. Nonaktifkan saja agar jejak audit tetap utuh.");
  d.delete("sellers", seller.id);
  log(d, userId, "HAPUS_PENJUAL", seller.name, "sellers", seller.id);
  return { deleted: true };
}

/* ------------------------------------------------------------------ lokasi */

export function listLocations(d, { includeInactive = true } = {}) {
  let rows = d.all("storage_locations");
  if (!includeInactive) rows = rows.filter((row) => row.active === 1);
  rows = rows.slice().sort((a, b) => nocase(a.code, b.code));
  return rows.map((row) => ({
    ...row,
    used: locationUsage(d, row.code),
  }));
}

function locationUsage(d, code) {
  return d.filter("transactions", (row) => row.location === code).length
    + d.filter("location_transfers", (row) => row.from_location === code || row.to_location === code).length
    + d.filter("stock_opname_items", (row) => row.location === code).length;
}

export function createLocation(d, userId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const code = text(payload.code, "Kode lokasi", true, 30).toUpperCase();
  const name = text(payload.name || code, "Nama lokasi", true, 80);
  const duplicate = d.where("storage_locations", (row) => String(row.code).toLowerCase() === code.toLowerCase()
    || String(row.name).toLowerCase() === name.toLowerCase());
  if (duplicate) throw new AppError("Kode atau nama lokasi sudah dipakai.");
  const locationId = d.allocate("storage_locations");
  d.insert("storage_locations", { id: locationId, code, name, active: 1, created_at: d.now });
  log(d, userId, "TAMBAH_LOKASI", `${code} | ${name}`, "storage_locations", locationId);
  return d.one("storage_locations", locationId);
}

export function updateLocation(d, userId, locationId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const current = d.one("storage_locations", Number(locationId));
  if (!current) throw new AppError("Lokasi tidak ditemukan.", 404);
  const name = text(payload.name ?? current.name, "Nama lokasi", true, 80);
  const code = text(payload.code ?? current.code, "Kode lokasi", true, 30).toUpperCase();
  if (code !== current.code) {
    if (d.filter("transactions", (row) => row.location === current.code).length) {
      throw new AppError("Kode lokasi tidak dapat diubah karena sudah dipakai transaksi.");
    }
    if (d.filter("location_transfers", (row) => row.from_location === current.code || row.to_location === current.code).length) {
      throw new AppError("Kode lokasi tidak dapat diubah karena sudah dipakai mutasi.");
    }
  }
  const duplicate = d.where("storage_locations", (row) => (String(row.code).toLowerCase() === code.toLowerCase()
    || String(row.name).toLowerCase() === name.toLowerCase()) && Number(row.id) !== Number(locationId));
  if (duplicate) throw new AppError("Kode atau nama lokasi sudah dipakai.");
  d.update("storage_locations", Number(locationId), { code, name });
  log(d, userId, "UBAH_LOKASI", `${code} | ${name}`, "storage_locations", Number(locationId));
  return d.one("storage_locations", Number(locationId));
}

export function toggleLocation(d, userId, locationId) {
  requirePrimary(currentUserRow(d, userId));
  const location = d.one("storage_locations", Number(locationId));
  if (!location) throw new AppError("Lokasi tidak ditemukan.", 404);
  const target = location.active ? 0 : 1;
  d.update("storage_locations", Number(locationId), { active: target });
  log(d, userId, "STATUS_LOKASI", `${location.code} | status=${target ? "AKTIF" : "NONAKTIF"}`, "storage_locations", Number(locationId));
  return { active: Boolean(target) };
}

export function deleteLocation(d, userId, locationId) {
  requireAdmin(currentUserRow(d, userId));
  const id = /^\d+$/.test(String(locationId)) ? Number(locationId) : locationId;
  const location = d.one("storage_locations", id);
  if (!location) throw new AppError("Lokasi tidak ditemukan.", 404);
  if (locationUsage(d, location.code)) {
    throw new AppError("Lokasi sudah dipakai data transaksi/opname. Nonaktifkan saja.");
  }
  d.delete("storage_locations", location.id);
  log(d, userId, "HAPUS_LOKASI", `${location.code} | ${location.name}`, "storage_locations", location.id);
  return { deleted: true };
}

/* ------------------------------------------------- master ukuran & harga */

export function listSpecs(d, { includeInactive = true } = {}) {
  const result = {};
  for (const dimension of ["T", "L", "P"]) {
    let rows = d.filter("master_spec_values", (row) => row.dimension === dimension);
    if (!includeInactive) rows = rows.filter((row) => row.active === 1);
    result[dimension] = rows.slice().sort((a, b) => Number(a.value) - Number(b.value));
  }
  return result;
}

export function listPrices(d, { includeInactive = true } = {}) {
  let rows = d.all("master_price_values");
  if (!includeInactive) rows = rows.filter((row) => row.active === 1);
  return rows.slice().sort((a, b) => Number(a.price) - Number(b.price));
}

export function createSpec(d, userId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const dimension = String(payload.dimension || "").trim().toUpperCase();
  if (!["T", "L", "P"].includes(dimension)) throw new AppError("Dimensi harus T, L, atau P.");
  const value = number(payload.value, "Nilai ukuran", 0.01);
  const duplicate = d.where("master_spec_values", (row) => row.dimension === dimension && Number(row.value) === Number(value));
  if (duplicate) throw new AppError("Nilai ukuran tersebut sudah ada pada dimensi ini.");
  const specId = d.allocate("master_spec_values");
  d.insert("master_spec_values", { id: specId, dimension, value, active: 1, created_at: d.now });
  log(d, userId, "TAMBAH_MASTER_UKURAN", `${dimension}=${pyG(value)}`, "master_spec_values", specId);
  return d.one("master_spec_values", specId);
}

export function updateSpec(d, userId, specId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const spec = d.one("master_spec_values", Number(specId));
  if (!spec) throw new AppError("Master ukuran tidak ditemukan.", 404);
  const value = number(payload.value ?? spec.value, "Nilai ukuran", 0.01);
  const duplicate = d.where("master_spec_values", (row) => row.dimension === spec.dimension
    && Number(row.value) === Number(value) && Number(row.id) !== Number(specId));
  if (duplicate) throw new AppError("Nilai ukuran tersebut sudah ada pada dimensi ini.");
  d.update("master_spec_values", Number(specId), { value });
  log(d, userId, "UBAH_MASTER_UKURAN", `${spec.dimension}=${pyG(value)}`, "master_spec_values", Number(specId));
  return d.one("master_spec_values", Number(specId));
}

export function toggleSpec(d, userId, specId) {
  requirePrimary(currentUserRow(d, userId));
  const spec = d.one("master_spec_values", Number(specId));
  if (!spec) throw new AppError("Master ukuran tidak ditemukan.", 404);
  const target = spec.active ? 0 : 1;
  d.update("master_spec_values", Number(specId), { active: target });
  log(d, userId, "STATUS_MASTER_UKURAN",
    `${spec.dimension}=${pyG(spec.value)} | status=${target ? "AKTIF" : "NONAKTIF"}`,
    "master_spec_values", Number(specId));
  return { active: Boolean(target) };
}

export function createPrice(d, userId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const price = number(payload.price, "Harga", 0.01);
  const duplicate = d.where("master_price_values", (row) => Number(row.price) === Number(price));
  if (duplicate) throw new AppError("Nilai harga tersebut sudah ada.");
  const priceId = d.allocate("master_price_values");
  d.insert("master_price_values", { id: priceId, price, active: 1, created_at: d.now });
  log(d, userId, "TAMBAH_MASTER_HARGA", `${pyG(price)}`, "master_price_values", priceId);
  return d.one("master_price_values", priceId);
}

export function updatePrice(d, userId, priceId, payload) {
  requireAdmin(currentUserRow(d, userId));
  const current = d.one("master_price_values", Number(priceId));
  if (!current) throw new AppError("Master harga tidak ditemukan.", 404);
  const price = number(payload.price ?? current.price, "Harga", 0.01);
  const duplicate = d.where("master_price_values", (row) => Number(row.price) === Number(price)
    && Number(row.id) !== Number(priceId));
  if (duplicate) throw new AppError("Nilai harga tersebut sudah ada.");
  d.update("master_price_values", Number(priceId), { price });
  log(d, userId, "UBAH_MASTER_HARGA", `${pyG(current.price)} -> ${pyG(price)}`, "master_price_values", Number(priceId));
  return d.one("master_price_values", Number(priceId));
}

export function togglePrice(d, userId, priceId) {
  requirePrimary(currentUserRow(d, userId));
  const price = d.one("master_price_values", Number(priceId));
  if (!price) throw new AppError("Master harga tidak ditemukan.", 404);
  const target = price.active ? 0 : 1;
  d.update("master_price_values", Number(priceId), { active: target });
  log(d, userId, "STATUS_MASTER_HARGA", `${pyG(price.price)} | status=${target ? "AKTIF" : "NONAKTIF"}`, "master_price_values", Number(priceId));
  return { active: Boolean(target) };
}

export function deletePrice(d, userId, priceId) {
  requireAdmin(currentUserRow(d, userId));
  const id = /^\d+$/.test(String(priceId)) ? Number(priceId) : priceId;
  const current = d.one("master_price_values", id);
  if (!current) throw new AppError("Master harga tidak ditemukan.", 404);
  const used = d.filter("product_active_prices", (row) => Number(row.active_price) === Number(current.price)
    && d.one("products", Number(row.product_id))).length;
  if (used > 0) {
    throw new AppError("Harga masih dipakai sebagai harga aktif barang. Ubah harga barang terlebih dahulu atau nonaktifkan saja.");
  }
  d.delete("master_price_values", current.id);
  log(d, userId, "HAPUS_MASTER_HARGA", `${pyG(current.price)}`, "master_price_values", current.id);
  return { deleted: true };
}

/* --------------------------------------------------------------- pengguna */

export function publicUser(row) {
  return {
    id: Number(row.id), username: row.username,
    full_name: row.full_name || "",
    role: row.role, is_primary_admin: Boolean(row.is_primary_admin),
    active: Boolean(row.active),
    created_at: row.created_at ?? null, last_login: row.last_login ?? null,
  };
}

export function currentUserRow(d, userId) {
  return d.one("users", Number(userId));
}

export function getActiveUser(d, userId) {
  const row = d.one("users", Number(userId));
  return row && row.active === 1 ? row : null;
}

export function listUsers(d, actor) {
  requireAdmin(actor);
  const rows = d.filter("users", (row) => String(row.username).toLowerCase() !== DEVELOPER_USERNAME.toLowerCase())
    .slice()
    .sort((a, b) => (Number(b.is_primary_admin) - Number(a.is_primary_admin)) || nocase(a.username, b.username));
  return rows.map((row) => ({ ...publicUser(row), is_self: Number(row.id) === Number(actor.id) }));
}

function activeAdminCount(d, exclude = null) {
  return d.filter("users", (row) => row.role === "admin" && row.active === 1 && (exclude === null || Number(row.id) !== Number(exclude))).length;
}

function usernameOf(value) {
  const username = text(value, "Username", true, 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) {
    throw new AppError("Username 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
  }
  if (username.toLowerCase() === DEVELOPER_USERNAME.toLowerCase()) {
    throw new AppError("Username tersebut khusus sistem dan tidak dapat digunakan.");
  }
  return username;
}

export async function createUser(d, actor, payload) {
  requireAdmin(actor);
  const username = usernameOf(payload.username);
  const password = String(payload.password || "");
  const confirm = String(payload.confirm_password || password);
  checkNewPassword(username, password, confirm);
  const fullName = text(payload.full_name, "Nama lengkap", false, 80);
  const role = String(payload.role || "user").trim().toLowerCase();
  if (!["user", "admin"].includes(role)) throw new AppError("Role harus user atau admin.");
  const duplicate = d.where("users", (row) => String(row.username).toLowerCase() === username.toLowerCase());
  if (duplicate) throw new AppError("Username sudah dipakai. Pilih username lain.");
  const userId = d.allocate("users");
  d.insert("users", {
    id: userId, username, full_name: fullName,
    password_hash: await hashPassword(password), role,
    is_primary_admin: 0, active: 1,
    created_at: d.now, last_login: null,
  });
  log(d, actor.id, "TAMBAH_PENGGUNA", `${username} | role=${role}`, "users", userId);
  return publicUser(d.one("users", userId));
}

export function updateUser(d, actor, userId, payload) {
  requireAdmin(actor);
  const target = d.one("users", Number(userId));
  if (!target) throw new AppError("Pengguna tidak ditemukan.", 404);
  if (target.is_primary_admin) throw new AppError("Akun Admin Utama tidak dapat diubah dari daftar pengguna.");
  if (Number(target.id) === Number(actor.id) && "active" in payload && !flag(payload.active)) {
    throw new AppError("Tidak dapat menonaktifkan akun yang sedang dipakai.");
  }
  const username = usernameOf(payload.username !== undefined ? payload.username : target.username);
  const fullName = text(payload.full_name !== undefined ? payload.full_name : target.full_name, "Nama lengkap", false, 80);
  const role = String(payload.role !== undefined ? payload.role : target.role).trim().toLowerCase();
  if (!["user", "admin"].includes(role)) throw new AppError("Role harus user atau admin.");
  const active = flag(payload.active !== undefined ? payload.active : target.active);
  if (Number(target.id) === Number(actor.id) && role !== "admin") {
    throw new AppError("Tidak dapat menurunkan role akun yang sedang dipakai.");
  }
  if (target.role === "admin" && (role !== "admin" || active === 0)) {
    if (activeAdminCount(d, Number(target.id)) < 1) throw new AppError("Harus tersisa minimal satu admin aktif.");
  }
  const duplicate = d.where("users", (row) => String(row.username).toLowerCase() === username.toLowerCase()
    && Number(row.id) !== Number(userId));
  if (duplicate) throw new AppError("Username sudah dipakai. Pilih username lain.");
  d.update("users", Number(userId), { username, full_name: fullName, role, active });
  log(d, actor.id, "UBAH_PENGGUNA",
    `${target.username} -> ${username} | role=${role} | active=${active}`,
    "users", Number(userId));
  return publicUser(d.one("users", Number(userId)));
}

export async function resetUserPassword(d, actor, userId, payload) {
  requireAdmin(actor);
  const target = d.one("users", Number(userId));
  if (!target) throw new AppError("Pengguna tidak ditemukan.", 404);
  if (target.is_primary_admin) {
    throw new AppError("Password Admin Utama hanya dapat diubah oleh akun tersebut melalui Ganti Password.");
  }
  if (Number(target.id) === Number(actor.id)) throw new AppError("Gunakan menu Ganti Password untuk akun sendiri.");
  const newPassword = String(payload.new_password || "");
  if (newPassword.length < 6) throw new AppError("Password sementara minimal 6 karakter.");
  checkNewPassword(target.username, newPassword, String(payload.confirm_password || newPassword));
  d.update("users", Number(userId), { password_hash: await hashPassword(newPassword), password_custom: 1 });
  log(d, actor.id, "RESET_PASSWORD_PENGGUNA", `target=${target.username}`, "users", Number(userId));
  return { id: Number(userId) };
}

export async function deleteUser(d, actor, userId, password) {
  requireAdmin(actor);
  const target = d.one("users", Number(userId));
  if (!target) throw new AppError("Pengguna tidak ditemukan.", 404);
  if (target.is_primary_admin) throw new AppError("Akun Admin Utama tidak dapat dihapus.");
  if (Number(target.id) === Number(actor.id)) throw new AppError("Pengguna yang sedang login tidak dapat dihapus.");
  const actorRow = d.where("users", (row) => Number(row.id) === Number(actor.id) && row.active === 1);
  if (!actorRow || !(await verifyPassword(String(password || ""), actorRow.password_hash))) {
    throw new AppError("Password administrator salah.");
  }
  const used = d.filter("transactions", (row) => Number(row.user_id) === Number(userId)).length
    + d.filter("location_transfers", (row) => Number(row.user_id) === Number(userId)).length
    + d.filter("stock_opname", (row) => Number(row.user_id) === Number(userId)).length
    + d.filter("activity_log", (row) => Number(row.user_id) === Number(userId)).length;
  if (used > 0) throw new AppError("Pengguna memiliki riwayat transaksi/aktivitas. Nonaktifkan akun agar jejak audit tetap utuh.");
  if (target.role === "admin" && activeAdminCount(d, Number(target.id)) < 1) {
    throw new AppError("Harus tersisa minimal satu admin aktif.");
  }
  d.delete("users", Number(userId));
  log(d, actor.id, "HAPUS_PENGGUNA", target.username, "users", Number(userId));
  return { deleted: true };
}

/* ------------------------------------------------------ backup/reset/sync */

export function createBackupPayload(d) {
  const tables = {};
  for (const name of [
    "users", "products", "product_active_prices", "master_spec_values",
    "master_price_values", "sellers", "storage_locations", "seller_rits",
    "transactions", "location_transfers", "tally_headers", "tally_items",
    "payment_recap_headers", "payment_recap_items", "stock_opname",
    "stock_opname_items", "stock_period_closures", "stock_period_closure_items",
    "activity_log", "sync_outbox",
  ]) {
    tables[name] = d.all(name).map((row) => ({ ...row }));
  }
  return {
    app: "PT. Belgindo Raya Inventory",
    edition: "Firebase Cloud",
    exported_at: d.now,
    tables,
  };
}

export const MASTER_TABLES = [
  "users", "products", "product_active_prices", "master_spec_values",
  "master_price_values", "sellers", "storage_locations", "app_meta",
];

const TRANSACTION_TABLES = [
  "stock_period_closure_items", "stock_period_closures", "tally_items", "tally_headers",
  "payment_recap_items", "payment_recap_headers", "stock_opname_items", "stock_opname",
  "location_transfers", "transactions", "seller_rits", "activity_log", "sync_outbox",
];

export async function resetTransactions(d, actor, password, confirmation) {
  requireAdmin(actor);
  if (String(confirmation || "").trim() !== "RESET") {
    throw new AppError("Ketik RESET dengan huruf kapital untuk mengonfirmasi.");
  }
  const actorRow = d.where("users", (row) => Number(row.id) === Number(actor.id) && row.active === 1);
  if (!actorRow || actorRow.role !== "admin" || !(await verifyPassword(String(password || ""), actorRow.password_hash))) {
    throw new AppError("Password administrator salah atau akun tidak lagi aktif.");
  }
  const masterBefore = new Map(MASTER_TABLES.map((table) => [table, d.all(table).length]));
  for (const table of TRANSACTION_TABLES) {
    /* Salin daftar dahulu: d.delete memodifikasi daftar yang sama. */
    for (const row of [...d.all(table)]) d.delete(table, Number(row.id));
  }
  for (const [table, original] of masterBefore.entries()) {
    const currentCount = d.all(table).length;
    if (currentCount !== original) {
      throw new AppError(`Integritas data master terganggu (tabel ${table}: ${original} -> ${currentCount}). Reset dibatalkan.`);
    }
  }
  log(d, actor.id, "RESET_TRANSAKSI", "Reset seluruh data transaksi; backup=(unduhan manual)", "app_meta", null);
  return { backup: "(unduh backup dari menu Backup sebelum reset)", deleted_tables: [...TRANSACTION_TABLES] };
}

export function syncStatus(d) {
  const counts = {};
  for (const row of d.all("sync_outbox")) {
    counts[row.status] = (counts[row.status] || 0) + 1;
  }
  const last = d.all("sync_outbox")
    .slice()
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  const pending = (counts.PENDING || 0) + (counts.FAILED || 0);
  return {
    mode: "FIREBASE",
    mode_label: "Firebase Firestore (Spark)",
    pending,
    failed: counts.FAILED || 0,
    synced: counts.SYNCED || 0,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    last: last ? { created_at: last.created_at, entity: last.entity, action: last.action } : null,
    message: pending === 0
      ? "Semua perubahan tersimpan di Firebase Firestore dan tercatat pada outbox audit."
      : `${pending} perubahan menunggu pemeriksaan pada outbox.`,
  };
}

export function retrySync(d, actor) {
  requireAdmin(actor);
  let updated = 0;
  for (const row of d.filter("sync_outbox", (item) => item.status === "PENDING" || item.status === "FAILED")) {
    d.update("sync_outbox", Number(row.id), { status: "SYNCED" });
    updated += 1;
  }
  log(d, actor.id, "SINKRONISASI_ULANG", `baris=${updated}`, "sync_outbox", null);
  return { updated, status: syncStatus(d) };
}

export function purgeSyncedOutbox(d, actor) {
  requirePrimary(actor);
  let deleted = 0;
  for (const row of d.filter("sync_outbox", (item) => item.status === "SYNCED")) {
    d.delete("sync_outbox", Number(row.id));
    deleted += 1;
  }
  log(d, actor.id, "BERSIHKAN_OUTBOX", `baris=${deleted}`, "sync_outbox", null);
  return { deleted };
}

/* ------------------------------------------------------------------- seed */

export const DEMO_ACCOUNTS = [
  ["administrator", "Administrator Utama", "administrator", "admin", 1],
  ["admin", "Admin Operasional", "admin123", "admin", 0],
];

/* Database kosong hanya ditanami akun login. Seluruh master data dan transaksi
   diisi sendiri oleh pengguna — tidak ada barang, penjual, atau nota contoh. */
export async function seedAccounts(d) {
  if (d.all("users").length) return false;
  for (const [username, fullName, password, role, primary] of DEMO_ACCOUNTS) {
    const userId = d.allocate("users");
    d.insert("users", {
      id: userId, username, full_name: fullName,
      password_hash: await hashPassword(password), role,
      is_primary_admin: primary, active: 1,
      created_at: d.now, last_login: null,
    });
  }
  return true;
}

/* ------------------------------------------------ pembersihan data demo lama */

/* Baris bawaan versi sebelumnya ditanam dengan nama dan catatan yang selalu
   sama, sehingga pola itulah yang dipakai untuk mengenalinya kembali. Data
   nyata dengan nama lain tidak tersentuh; baris yang masih dirujuk data nyata
   ikut dipertahankan. */
export const DEMO_PURGE_ACTION = "BERSIHKAN_DATA_DEMO";

const DEMO_PRODUCT_NAMES = [
  "MERANTI MERAH", "KRUING PUTIH", "BANGKIRAI SUPER", "KAMPER JAYA", "SENGON LAUT", "RIMBA CAMPUR",
];
const DEMO_SELLER_NAMES = [
  "CV. SUMBER JAYA", "UD. KARYA ABADI", "PT. RIMBA NUSANTARA", "TOKO SENTOSA",
];
const DEMO_LOCATION_CODES = ["GUDANG A", "GUDANG B", "GUDANG KERING"];
const DEMO_SPEC_VALUES = [
  ["T", 20], ["T", 25], ["T", 30], ["T", 35], ["T", 40], ["T", 42], ["T", 45],
  ["L", 8], ["L", 10], ["L", 12], ["L", 14], ["L", 16],
  ["P", 100], ["P", 130],
];
const DEMO_PRICE_VALUES = [2200000, 2500000, 2800000, 3000000, 3200000, 3500000, 4000000];
const DEMO_NOTE_TEXTS = [
  "Pengiriman rutin awal periode", "Pengiriman periode berjalan",
  "Pasokan rutin", "Penerimaan periode berjalan",
  "Pemakaian produksi meja", "Pemakaian produksi kursi", "Pemakaian produksi lemari",
  "Penataan ulang gudang", "Persiapan pengiriman", "Mutasi untuk pesanan khusus",
  "Sebagian batang retak",
];

function isDemoText(value, list) {
  const clean = String(value ?? "").trim().toLowerCase();
  return Boolean(clean) && list.some((item) => String(item).trim().toLowerCase() === clean);
}

function isDemoNote(value) {
  return isDemoText(value, DEMO_NOTE_TEXTS);
}

export function demoPurgeDone(d) {
  return d.all("activity_log").some((row) => String(row.action) === DEMO_PURGE_ACTION);
}

export function purgeDemoData(d) {
  const counts = {
    rits: 0, transactions: 0, tallies: 0, recaps: 0, transfers: 0,
    opname: 0, products: 0, sellers: 0, locations: 0, specs: 0, prices: 0, logs: 0,
  };
  const deletedRefs = new Set();
  const drop = (table, row) => {
    deletedRefs.add(`${table}/${row.id}`);
    d.delete(table, Number(row.id));
  };
  const idsOf = (rows) => new Set(rows.map((row) => Number(row.id)));

  const ritIds = idsOf(d.filter("seller_rits", (row) => isDemoNote(row.note)));
  const productIds = idsOf(d.filter("products", (row) => isDemoText(row.name, DEMO_PRODUCT_NAMES)));
  const sellerIds = idsOf(d.filter("sellers", (row) => isDemoText(row.name, DEMO_SELLER_NAMES)));

  const trxIds = idsOf(d.filter("transactions", (row) => ritIds.has(Number(row.rit_id))
    || productIds.has(Number(row.product_id))
    || sellerIds.has(Number(row.seller_id))
    || isDemoNote(row.note)));

  /* Tally dan rekap lebih dahulu: keduanya memegang rujukan ke nota demo. */
  const tallyIds = idsOf(d.filter("tally_headers", (row) => ritIds.has(Number(row.rit_id))
    || sellerIds.has(Number(row.seller_id))));
  const doomedTallyItems = [...d.all("tally_items")].filter((row) => {
    if (trxIds.has(Number(row.trx_id)) || productIds.has(Number(row.product_id))) {
      tallyIds.add(Number(row.tally_id));
      return true;
    }
    return tallyIds.has(Number(row.tally_id));
  });
  for (const row of doomedTallyItems) drop("tally_items", row);
  for (const row of [...d.all("tally_headers")].filter((item) => tallyIds.has(Number(item.id)))) {
    drop("tally_headers", row);
    counts.tallies += 1;
  }

  const recapIds = idsOf(d.filter("payment_recap_headers", (row) => ritIds.has(Number(row.rit_id))
    || sellerIds.has(Number(row.seller_id))));
  const doomedRecapItems = [...d.all("payment_recap_items")].filter((row) => {
    if (trxIds.has(Number(row.trx_id))) {
      recapIds.add(Number(row.recap_id));
      return true;
    }
    return recapIds.has(Number(row.recap_id));
  });
  for (const row of doomedRecapItems) drop("payment_recap_items", row);
  for (const row of [...d.all("payment_recap_headers")].filter((item) => recapIds.has(Number(item.id)))) {
    drop("payment_recap_headers", row);
    counts.recaps += 1;
  }

  for (const row of [...d.all("transactions")].filter((item) => trxIds.has(Number(item.id)))) {
    drop("transactions", row);
    counts.transactions += 1;
  }

  /* Mutasi hanya ikut terhapus bila barang/catatannya demo; lokasi yang masih
     dipakai mutasi nyata tidak dibuang. */
  const doomedTransfers = [...d.all("location_transfers")].filter((row) => productIds.has(Number(row.product_id))
    || isDemoNote(row.note));
  for (const row of doomedTransfers) {
    drop("location_transfers", row);
    counts.transfers += 1;
  }

  /* Opname dan penutupan periode demo: barisnya pasti merujuk barang demo,
     sesi yang tinggal kosong ikut dihapus agar kunci periode lepas. */
  for (const row of [...d.all("stock_opname_items")].filter((item) => productIds.has(Number(item.product_id)))) {
    drop("stock_opname_items", row);
  }
  for (const row of [...d.all("stock_period_closure_items")].filter((item) => productIds.has(Number(item.product_id)))) {
    drop("stock_period_closure_items", row);
  }
  const itemsLeft = (table, key, id) => d.all(table).some((row) => Number(row[key]) === id);
  const doomedSessions = [...d.all("stock_opname")].filter((row) => !itemsLeft("stock_opname_items", "opname_id", Number(row.id)));
  const sessionIds = idsOf(doomedSessions);
  for (const row of doomedSessions) {
    drop("stock_opname", row);
    counts.opname += 1;
  }
  for (const row of [...d.all("stock_period_closures")]
    .filter((item) => sessionIds.has(Number(item.opname_id))
      || !itemsLeft("stock_period_closure_items", "closure_id", Number(item.id)))) {
    drop("stock_period_closures", row);
  }

  for (const row of [...d.all("seller_rits")].filter((item) => ritIds.has(Number(item.id))
    || sellerIds.has(Number(item.seller_id)))) {
    drop("seller_rits", row);
    counts.rits += 1;
  }

  /* Master data: hanya yang sudah tidak dirujuk data nyata yang dibuang. */
  const usedByStock = (productId) => ["transactions", "tally_items", "location_transfers", "stock_opname_items",
    "stock_period_closure_items", "payment_recap_items"].some((table) => d.all(table).some((row) => Number(row.product_id) === productId));
  const doomedProducts = [...d.all("products")].filter((row) => isDemoText(row.name, DEMO_PRODUCT_NAMES)
    && !usedByStock(Number(row.id)));
  for (const row of doomedProducts) {
    const priceRow = d.one("product_active_prices", Number(row.id));
    if (priceRow) drop("product_active_prices", priceRow);
    drop("products", row);
    counts.products += 1;
  }

  const doomedSellers = [...d.all("sellers")].filter((row) => isDemoText(row.name, DEMO_SELLER_NAMES)
    && !d.all("seller_rits").some((rit) => Number(rit.seller_id) === Number(row.id))
    && !d.all("transactions").some((trx) => Number(trx.seller_id) === Number(row.id)));
  for (const row of doomedSellers) {
    drop("sellers", row);
    counts.sellers += 1;
  }

  const sameCode = (value, code) => String(value ?? "").trim().toLowerCase() === String(code).trim().toLowerCase();
  const doomedLocations = [...d.all("storage_locations")].filter((row) => isDemoText(row.code, DEMO_LOCATION_CODES)
    && !d.all("transactions").some((trx) => sameCode(trx.location, row.code))
    && !d.all("location_transfers").some((trx) => sameCode(trx.from_location, row.code) || sameCode(trx.to_location, row.code))
    && !d.all("stock_opname_items").some((item) => sameCode(item.location, row.code)));
  for (const row of doomedLocations) {
    drop("storage_locations", row);
    counts.locations += 1;
  }

  const specInUse = (dimension, value) => d.all("products").some((row) => {
    const column = dimension === "T" ? row.spec_t : dimension === "L" ? row.spec_l : row.spec_p;
    return Number(column) === Number(value);
  });
  for (const row of [...d.all("master_spec_values")]) {
    const paired = DEMO_SPEC_VALUES.some(([dimension, value]) => String(row.dimension).toUpperCase() === dimension
      && Number(row.value) === Number(value));
    if (paired && !specInUse(String(row.dimension).toUpperCase(), row.value)) {
      drop("master_spec_values", row);
      counts.specs += 1;
    }
  }

  const priceInUse = (value) => d.all("products").some((row) => Number(row.purchase_price) === Number(value))
    || d.all("product_active_prices").some((row) => Number(row.active_price) === Number(value))
    || d.all("transactions").some((row) => Number(row.price) === Number(value));
  for (const row of [...d.all("master_price_values")]) {
    if (DEMO_PRICE_VALUES.includes(Number(row.price)) && !priceInUse(row.price)) {
      drop("master_price_values", row);
      counts.prices += 1;
    }
  }

  const demoWords = [...DEMO_PRODUCT_NAMES, ...DEMO_SELLER_NAMES, ...DEMO_LOCATION_CODES, ...DEMO_NOTE_TEXTS]
    .map((word) => word.toLowerCase());
  for (const row of [...d.all("activity_log")]) {
    const detail = String(row.detail ?? "").toLowerCase();
    if (demoWords.some((word) => detail.includes(word))) {
      d.delete("activity_log", Number(row.id));
      counts.logs += 1;
    }
  }
  for (const row of [...d.all("sync_outbox")]) {
    if (deletedRefs.has(`${row.entity}/${row.entity_id}`)) d.delete("sync_outbox", Number(row.id));
  }

  const total = counts.rits + counts.transactions + counts.tallies + counts.recaps + counts.transfers
    + counts.opname + counts.products + counts.sellers + counts.locations + counts.specs + counts.prices;
  log(d, null, DEMO_PURGE_ACTION,
    `rit=${counts.rits} transaksi=${counts.transactions} tally=${counts.tallies} rekap=${counts.recaps} `
    + `mutasi=${counts.transfers} opname=${counts.opname} barang=${counts.products} `
    + `penjual=${counts.sellers} gudang=${counts.locations} spek=${counts.specs} harga=${counts.prices} `
    + `jejak=${counts.logs} total=${total}`, "app_meta", null);
  return counts;
}
