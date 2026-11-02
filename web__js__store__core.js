/* Port server/core.py: konstanta, galat, tanggal, angka desimal, dan ukuran.
   Dipakai bersama seluruh store edisi Firestore. */

export const APP_NAME = "PT. BELGINDO RAYA INVENTORY";
export const APP_SUBTITLE = "Inventori Kayu";
export const APP_VERSION = "1.0.99";
export const APP_EDITION = "Firebase Cloud";
export const M3_DIVISOR = 10000000;
export const EPS = 1e-9;

export const PRODUCT_UNITS = ["BATANG", "LEMBAR", "KUBIK", "TON"];
export const IMPORT_PREFIX = "IMP/";
export const MIN_PASSWORD_LENGTH = 6;

export const DEFAULT_PASSWORDS = {
  administrator: new Set(["administrator"]),
  admin: new Set(["123", "admin123"]),
};
export const DEVELOPER_USERNAME = "administrator";
export const FIRST_LOGIN_USERNAME = "admin";
export const FIRST_LOGIN_PASSWORD = "123";
export const WEAK_PASSWORDS = new Set([
  "123", "1234", "12345", "123456", "111111", "password", "admin",
  "administrator", "admin123", "qwerty", "belgindo", "belgindo123",
]);

export const OPNAME_REASONS = [
  "Salah hitung / perlu hitung ulang",
  "Transaksi belum tercatat",
  "Salah catat transaksi",
  "Susut / rusak / afkir",
  "Pindah lokasi belum dicatat",
  "Barang temuan",
  "Lainnya",
];
export const OPNAME_REASON_OTHER = "Lainnya";

export class AppError extends Error {
  constructor(message, { status = 400, code = "BUSINESS_RULE" } = {}) {
    super(message || "Terjadi kesalahan.");
    this.name = "AppError";
    this.message = message || "Terjadi kesalahan.";
    this.status = status;
    this.code = code;
  }
}

export class AuthError extends AppError {
  constructor(message, { status = 401, code = "UNAUTHORIZED" } = {}) {
    super(message, { status, code });
    this.name = "AuthError";
  }
}

/* ------------------------------------------------------------------ waktu */

export function nowISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateParts(text) {
  const clean = String(text || "").trim().slice(0, 10);
  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})$/,
    /^(\d{2})-(\d{2})-(\d{4})$/,
    /^(\d{2})\/(\d{2})\/(\d{4})$/,
  ];
  for (let i = 0; i < formats.length; i += 1) {
    const match = formats[i].exec(clean);
    if (!match) continue;
    let year, month, day;
    if (i === 0) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    else [year, month, day] = [Number(match[3]), Number(match[2]), Number(match[1])];
    const probe = new Date(year, month - 1, day);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) continue;
    return { year, month, day };
  }
  return null;
}

export function parseISODate(value, field = "Tanggal") {
  const parts = parseDateParts(value);
  if (!parts) throw new AppError(`${field} tidak valid. Gunakan format DD-MM-YYYY.`);
  return parts;
}

export function isoDate(value, field = "Tanggal") {
  const { year, month, day } = parseISODate(value, field);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function displayDate(value) {
  const parts = parseDateParts(String(value || "").slice(0, 10));
  if (!parts) return "-";
  return `${String(parts.day).padStart(2, "0")}-${String(parts.month).padStart(2, "0")}-${parts.year}`;
}

export function addDays(isoValue, days) {
  const { year, month, day } = parseISODate(isoValue);
  const probe = new Date(year, month - 1, day + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${probe.getFullYear()}-${pad(probe.getMonth() + 1)}-${pad(probe.getDate())}`;
}

export function monthBounds(year, month) {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year + (month === 12 ? 1 : 0), month % 12, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return [`${first.getFullYear()}-${pad(first.getMonth() + 1)}-01`, `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`];
}

export function dateObject(parts) {
  return new Date(parts.year, parts.month - 1, parts.day);
}

/* ------------------------------------------------------- angka & desimal */

/* Pembulatan setengah-ke-atas pada taraf desimal tertentu, bekerja pada
   representasi string agar bebas dari kesalahan biner pada batas .5. */
export function roundHalfUp(value, digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const negative = num < 0;
  const text = Math.abs(num).toFixed(Math.min(digits + 6, 12));
  let [whole, frac = ""] = text.split(".");
  let keep = frac.slice(0, digits).padEnd(digits, "0");
  const rest = frac.slice(digits);
  if (rest && Number(`0.${rest}`) >= 0.5) {
    if (digits === 0) whole = String(BigInt(whole) + 1n);
    else keep = String(BigInt(keep) + 1n).padStart(digits, "0");
  }
  const body = digits > 0 ? `${whole}.${keep}` : whole;
  const result = Number(body);
  return negative ? -result : result;
}

/* round() Python memakai setengah-ke-genap; dipakai untuk membulatkan
   nilai agregat agar perilakunya mendekati server. */
export function pyRound(value, digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, digits);
  const scaled = num * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const eps = 1e-9;
  let base;
  if (Math.abs(diff - 0.5) < eps) {
    base = floor % 2 === 0 ? floor : floor + 1;
  } else {
    base = Math.round(scaled);
  }
  return base / factor;
}

/* trim_number: hilangkan nol berlebih tanpa notasi eksponen. */
export function trimNumber(value) {
  if (value === null || value === undefined || value === "") return String(value ?? "");
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (num === 0) return "0";
  if (Number.isInteger(num)) return String(num);
  let text = num.toFixed(12);
  text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text;
}

export function fmtQty(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  const text = roundHalfUp(num, 2).toFixed(2);
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed.replace(".", ",");
}

export function m3Text(value, decimals = 6) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  let text = roundHalfUp(num, decimals).toFixed(decimals);
  text = text.replace(/0+$/, "").replace(/\.$/, "");
  return (text || "0").replace(".", ",");
}

export function moneyText(value) {
  const num = Number(value || 0);
  const safe = Number.isFinite(num) ? num : 0;
  const amount = roundHalfUp(safe, 2);
  const sign = amount < 0 ? "-" : "";
  const [whole, cents = "00"] = Math.abs(amount).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  if (cents === "00") return `${sign}Rp ${grouped}`;
  return `${sign}Rp ${grouped},${cents}`;
}

/* ---------------------------------------------------------------- ukuran */

export function normalizeSize(size) {
  const text = String(size || "").trim().toLowerCase().replace(/×/g, "x").replace(/\s+/g, "");
  if (!text) return "";
  const parts = text.split("x");
  if (parts.length !== 3) throw new AppError("Ukuran harus terdiri dari Lebar, Tebal, dan Panjang.");
  const values = parts.map((part) => {
    const num = Number(part.replace(",", "."));
    if (!Number.isFinite(num)) throw new AppError("Ukuran harus berupa angka.");
    return num;
  });
  if (values.some((value) => value <= 0)) throw new AppError("Ukuran harus lebih besar dari 0.");
  return values.map((value) => trimNumber(value)).join("x");
}

export function makeSize(thickness, width, length) {
  const t = Number(String(thickness).replace(",", "."));
  const l = Number(String(width).replace(",", "."));
  const p = Number(String(length).replace(",", "."));
  if (![t, l, p].every((value) => Number.isFinite(value))) throw new AppError("Ukuran T, L, dan P harus berupa angka.");
  if (Math.min(t, l, p) <= 0) throw new AppError("Ukuran T, L, dan P harus lebih besar dari 0.");
  return `${trimNumber(l)}x${trimNumber(t)}x${trimNumber(p)}`;
}

export function sizeParts(size) {
  const normalized = normalizeSize(size);
  if (!normalized) return [0, 0, 0];
  const [l, t, p] = normalized.split("x").map(Number);
  return [l, t, p];
}

export function sizeDisplay(size) {
  try {
    const [l, t, p] = sizeParts(size);
    if (!(l && t && p)) return "-";
    return `${trimNumber(t)} × ${trimNumber(l)} × ${trimNumber(p)}`;
  } catch (error) {
    if (error instanceof AppError) return String(size || "-");
    throw error;
  }
}

export function m3Value(size, qty) {
  try {
    const [l, t, p] = sizeParts(size);
    return (l * t * p * Number(qty)) / M3_DIVISOR;
  } catch (error) {
    if (error instanceof AppError) return 0;
    throw error;
  }
}

/* line_amount: volume × harga dengan pembulatan half-up 2 desimal,
   konsisten dengan Decimal(str(volume)) * Decimal(str(price)). */
export function lineAmount(size, qty, price) {
  try {
    const volume = m3Value(size, qty);
    return roundHalfUp2(volume * Number(price || 0));
  } catch (error) {
    return 0;
  }
}

export function roundHalfUp2(value) {
  return roundHalfUp(value, 2);
}

/* ---------------------------------------------------------------- lainnya */

export function usesDefaultPassword(username, password) {
  const key = String(username || "").trim().toLowerCase();
  return DEFAULT_PASSWORDS[key]?.has(String(password || "")) || false;
}

export function checkNewPassword(username, newPassword, confirm, oldPassword = null) {
  const next = String(newPassword || "");
  if (!next || !String(confirm || "")) throw new AppError("Password baru dan konfirmasi wajib diisi.");
  if (next !== String(confirm)) throw new AppError("Password baru dan konfirmasi tidak sama.");
  if (next.length < MIN_PASSWORD_LENGTH) throw new AppError(`Password baru minimal ${MIN_PASSWORD_LENGTH} karakter.`);
  if (oldPassword !== null && next === String(oldPassword)) throw new AppError("Password baru tidak boleh sama dengan password lama.");
  if (next.trim().toLowerCase() === String(username || "").trim().toLowerCase()) throw new AppError("Password baru tidak boleh sama dengan username.");
  if (WEAK_PASSWORDS.has(next.trim().toLowerCase()) || usesDefaultPassword(username, next)) {
    throw new AppError("Password terlalu mudah ditebak. Pilih password lain.");
  }
}

/* PBKDF2-SHA256 memakai WebCrypto; format identik dengan server lokal.
   Bila crypto.subtle tidak tersedia (halaman dibuka lewat http selain
   localhost, mis. IP LAN), fallback murni JavaScript dipakai sehingga
   login tetap berfungsi dengan format hash yang sama persis. */
export async function hashPassword(password, iterations = 200000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${toB64(salt)}$${toB64(digest)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algorithm, iterations, salt, digest] = String(stored).split("$");
    if (algorithm !== "pbkdf2_sha256") return false;
    const computed = await pbkdf2(password, fromB64(salt), Number(iterations));
    return toB64(computed) === digest;
  } catch {
    return false;
  }
}

function pbkdf2Available() {
  try {
    return Boolean(crypto?.subtle?.importKey && crypto?.subtle?.deriveBits);
  } catch {
    return false;
  }
}

async function pbkdf2(password, salt, iterations) {
  if (pbkdf2Available()) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  }
  return pbkdf2Js(password, salt, iterations);
}

/* ------------------------------------------- fallback PBKDF2 (tanpa WebCrypto) */

/* SHA-256 murni JavaScript — hanya dipakai bila crypto.subtle tidak ada.
   Format keluaran identik dengan hashlib.pbkdf2_hmac Python (256-bit). */

const JS_SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Blocks(state, words, offset) {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i += 1) w[i] = words[offset + i];
  for (let i = 16; i < 64; i += 1) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = 0; i < 64; i += 1) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + JS_SHA_K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
}

function sha256Bytes(input) {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) * 16;
  const words = new Uint32Array(paddedLength);
  for (let i = 0; i < input.length; i += 1) {
    words[i >> 2] |= input[i] << ((3 - (i & 3)) * 8);
  }
  words[input.length >> 2] |= 0x80 << ((3 - (input.length & 3)) * 8);
  words[paddedLength - 1] = bitLength >>> 0;
  words[paddedLength - 2] = Math.floor(bitLength / 0x100000000);
  for (let offset = 0; offset < paddedLength; offset += 16) sha256Blocks(state, words, offset);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    out[i * 4] = state[i] >>> 24; out[i * 4 + 1] = (state[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (state[i] >>> 8) & 0xff; out[i * 4 + 3] = state[i] & 0xff;
  }
  return out;
}

function hmacSha256Js(key, message) {
  let keyBytes = key;
  if (keyBytes.length > 64) keyBytes = sha256Bytes(keyBytes);
  const ipad = new Uint8Array(64 + message.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i += 1) {
    const k = i < keyBytes.length ? keyBytes[i] : 0;
    ipad[i] = k ^ 0x36;
    opad[i] = k ^ 0x5c;
  }
  ipad.set(message, 64);
  opad.set(sha256Bytes(ipad), 64);
  return sha256Bytes(opad);
}

function pbkdf2Js(password, salt, iterations, dkLen = 32) {
  const passwordBytes = new TextEncoder().encode(String(password));
  const blocks = Math.ceil(dkLen / 32);
  const output = new Uint8Array(blocks * 32);
  const saltBlock = new Uint8Array(salt.length + 4);
  saltBlock.set(salt, 0);
  for (let block = 1; block <= blocks; block += 1) {
    saltBlock[salt.length] = (block >>> 24) & 0xff;
    saltBlock[salt.length + 1] = (block >>> 16) & 0xff;
    saltBlock[salt.length + 2] = (block >>> 8) & 0xff;
    saltBlock[salt.length + 3] = block & 0xff;
    let u = hmacSha256Js(passwordBytes, saltBlock);
    const acc = u.slice();
    for (let i = 1; i < iterations; i += 1) {
      u = hmacSha256Js(passwordBytes, u);
      for (let j = 0; j < 32; j += 1) acc[j] ^= u[j];
    }
    output.set(acc, (block - 1) * 32);
  }
  return output.slice(0, dkLen);
}

/* Kait pengujian: fallback PBKDF2 dibandingkan dengan hashlib Python. */
export const _pbkdf2JsForTests = pbkdf2Js;

function toB64(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromB64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function pad2(value) {
  return String(Number(value)).padStart(2, "0");
}

/* Normalisasi ID Firestore: ID numerik disimpan sebagai Number, sedangkan
   UUID/string legacy tetap dipertahankan agar dokumen lama masih dapat
   dicocokkan tanpa merusak referensi. */
export function asId(value) {
  if (value === null || value === undefined || value === "") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : value;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? Number(text) : value;
}
/* str(float) Python: bilangan bulat tetap diberi ".0". */
export function pyFloatStr(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (Number.isInteger(num) && Math.abs(num) < 1e16) return `${num}.0`;
  return String(num);
}

/* Format "%g" Python: 6 digit signifikan, nol trainer dihilangkan,
   notasi ilmiah bila eksponen di luar [-4, 6). */
export function pyG(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (num === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(num)));
  if (exp >= -4 && exp < 6) {
    const digits = Math.max(0, 6 - 1 - exp);
    let text = num.toFixed(digits);
    if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
    return text;
  }
  let mantissa = num.toExponential(5);
  let [base, ex] = mantissa.split("e");
  if (base.includes(".")) base = base.replace(/0+$/, "").replace(/\.$/, "");
  const expNum = Number(ex);
  const sign = expNum < 0 ? "-" : "+";
  return `${base}e${sign}${String(Math.abs(expNum)).padStart(2, "0")}`;
}
