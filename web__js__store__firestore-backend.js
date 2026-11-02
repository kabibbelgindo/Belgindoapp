/* Backend Firestore untuk edisi cloud — murni REST API (tanpa SDK Firebase).
   Keputusan rancangan: SDK memakai kanal WebSocket/long-polling yang sering
   diblokir jaringan kantor/VPN dan menambah unduhan CDN; REST biasa
   selalu lolos, cepat, dan cukup untuk pola akses aplikasi ini
   (muat semua koleksi sekali, lalu commit batch per transaksi).
   Paket Spark (gratis), tanpa Firebase Auth — akses dikendalikan
   aturan keamanan firestore.rules yang menyertai paket ini. */

import { COLLECTIONS } from "./engine.js";

const API_BASE = "https://firestore.googleapis.com/v1";
const PAGE_SIZE = 300;
const CHUNK = 450; /* batas operasi per commit Firestore (500, ambil aman) */

function dbPath(config) {
  return `projects/${encodeURIComponent(config.projectId)}/databases/(default)`;
}

function withKey(config, path, params = {}) {
  const search = new URLSearchParams({ key: config.apiKey, ...params });
  return `${API_BASE}/${path}?${search.toString()}`;
}

/* Pemeriksaan awal lewat REST: menentukan penyebab kegagalan (database belum
   dibuat, aturan menolak, atau galat lain) sebelum pengguna mencoba login,
   lengkap dengan petunjuk perbaikan di layar penyiapan. */
export async function probeFirestore(config) {
  const projectId = config.projectId;
  const url = withKey(config, `${dbPath(config)}/documents/users`, { pageSize: "1" });
  try {
    const response = await fetch(url, { method: "GET" });
    if (response.ok) return { ok: true, kind: "READY", projectId };
    const payload = await response.json().catch(() => ({}));
    const error = payload.error || {};
    const status = String(error.status || "");
    const message = String(error.message || `HTTP ${response.status}`);
    if (response.status === 404 || status === "NOT_FOUND") {
      return {
        ok: false, kind: "DB_MISSING", projectId,
        message: "Database Firestore belum dibuat untuk proyek ini.",
        detail: message,
      };
    }
    if (response.status === 403 || status === "PERMISSION_DENIED") {
      return {
        ok: false, kind: "RULES_DENIED", projectId,
        message: "Aturan keamanan Firestore menolak akses aplikasi.",
        detail: message,
      };
    }
    return {
      ok: false, kind: "OTHER", projectId,
      message: "Firestore merespons dengan galat.",
      detail: `${status || response.status}: ${message}`,
    };
  } catch (error) {
    return {
      ok: false, kind: "NETWORK", projectId,
      message: "Tidak dapat menghubungi server Firestore.",
      detail: error?.message || "Koneksi internet bermasalah.",
    };
  }
}

/* ------------------------------------------------------------- kode nilai */

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { nullValue: null };
    if (Number.isSafeInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === "object") {
    const fields = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      fields[key] = encodeValue(item);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function decodeValue(raw) {
  if (!raw || typeof raw !== "object") return null;
  if ("stringValue" in raw) return raw.stringValue ?? "";
  if ("integerValue" in raw) return Number(raw.integerValue);
  if ("doubleValue" in raw) return Number(raw.doubleValue || 0);
  if ("booleanValue" in raw) return Boolean(raw.booleanValue);
  if ("nullValue" in raw) return null;
  if ("arrayValue" in raw) return (raw.arrayValue?.values || []).map(decodeValue);
  if ("mapValue" in raw) return decodeFields(raw.mapValue?.fields || {});
  if ("timestampValue" in raw) return String(raw.timestampValue);
  if ("referenceValue" in raw) return String(raw.referenceValue);
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [key, raw] of Object.entries(fields || {})) out[key] = decodeValue(raw);
  return out;
}

const NUMERIC_ID_FIELDS = new Set([
  "id", "product_id", "seller_id", "rit_id", "source_trx_id", "trx_id", "tally_id",
  "recap_id", "opname_id", "closure_id", "user_id", "created_by", "updated_by",
  "approved_by", "entity_id", "spec_id", "price_id", "location_id", "transfer_id",
]);

function normalizeRecordIds(record) {
  const normalized = { ...record };
  for (const [key, value] of Object.entries(normalized)) {
    if (!NUMERIC_ID_FIELDS.has(key) && !key.endsWith("_id")) continue;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) normalized[key] = Number(value);
  }
  if (typeof normalized.rit_number === "string" && /^\d+$/.test(normalized.rit_number.trim())) {
    normalized.rit_number = Number(normalized.rit_number);
  }
  return normalized;
}

function decodeDocument(doc) {
  const idText = String(doc.name || "").split("/").pop() || "0";
  const fields = normalizeRecordIds(decodeFields(doc.fields || {}));
  /* Id dokumen aplikasi selalu angka; id asing (UUID) dipertahankan apa adanya
     agar dapat dibersihkan oleh perbaikan seed. */
  let id;
  if (fields.id !== undefined && fields.id !== null) id = fields.id;
  else if (/^\d+$/.test(idText)) id = Number(idText);
  else id = idText;
  return { ...fields, id: typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id };
}

/* --------------------------------------------------------------- backend */

export async function createFirestoreBackend(config) {
  const path = dbPath(config);
  const documentsPath = `${path}/documents`;
  const docName = (collectionName, id) => `${documentsPath}/${collectionName}/${String(id)}`;

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const error = payload?.error || {};
      const code = String(error.status || "");
      if (response.status === 404 || code === "NOT_FOUND") {
        throw new Error(
          "Firestore belum dibuat untuk proyek ini. Buka Firebase Console → Firestore Database → Create database.",
          { cause: { kind: "DB_MISSING" } },
        );
      }
      if (response.status === 403 || code === "PERMISSION_DENIED") {
        throw new Error(
          "Akses Firestore ditolak. Terbitkan aturan keamanan (firestore.rules) di Firebase Console → Firestore → Rules.",
          { cause: { kind: "RULES_DENIED" } },
        );
      }
      /* Precondition rev gagal: perangkat lain menulis lebih dulu. */
      if (response.status === 409 || code === "ABORTED" || code === "ALREADY_EXISTS" || code === "FAILED_PRECONDITION") {
        throw new Error("Konflik penulisan Firestore.", { cause: { kind: "CONFLICT" } });
      }
      throw new Error(error.message || `Firestore merespons ${response.status}.`);
    }
    return payload;
  }

  async function listCollection(name) {
    const docs = [];
    let pageToken = "";
    do {
      const params = { pageSize: String(PAGE_SIZE) };
      if (pageToken) params.pageToken = pageToken;
      const payload = await requestJson(withKey(config, `${documentsPath}/${name}`, params));
      for (const doc of payload.documents || []) docs.push(decodeDocument(doc));
      pageToken = String(payload.nextPageToken || "");
    } while (pageToken);
    return docs;
  }

  async function loadAll(collections) {
    /* Meta dibaca DULU: bila perangkat lain menulis saat koleksi dibaca, data
       paling tidak seterbaru rev ini, dan pemeriksaan berikutnya akan melihat
       rev yang lebih baru lalu menarik selisihnya (tidak ada perubahan hilang). */
    const meta = await loadMeta();
    const payload = { _meta: { rev: meta.rev }, _counters: meta.counters };
    await Promise.all(collections.map(async (name) => {
      payload[name] = await listCollection(name);
    }));
    return payload;
  }

  /* batchGet: dokumen yang tidak ada dikembalikan sebagai null (bukan 404),
     sehingga database baru tidak memunculkan galat di konsol browser. */
  async function batchGet(names) {
    const found = new Map();
    for (let index = 0; index < names.length; index += 100) {
      const slice = names.slice(index, index + 100);
      const payload = await requestJson(withKey(config, `${documentsPath}:batchGet`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: slice }),
      });
      for (const entry of Array.isArray(payload) ? payload : []) {
        if (entry.found) found.set(entry.found.name, entry.found);
      }
    }
    return names.map((name) => found.get(name) || null);
  }

  /* updateTime dokumen rev dipakai sebagai precondition setiap commit. */
  let revUpdateTime = null;

  async function loadMeta() {
    try {
      const [revDoc, counterDoc] = await batchGet([docName("_meta", "rev"), docName("_meta", "counters")]);
      revUpdateTime = revDoc?.updateTime || null;
      return {
        rev: revDoc ? Number(decodeFields(revDoc.fields || {}).rev || 0) : 0,
        counters: counterDoc ? decodeFields(counterDoc.fields || {}) : {},
      };
    } catch (error) {
      revUpdateTime = null;
      throw error; /* database baru TIDAK menimbulkan galat: batchGet melaporkan "tidak ada" */
    }
  }

  /* Tarik hanya dokumen yang berubah sejak rev lokal (lewat dokumen
     _meta/chg-<rev> yang ditulis tiap commit). Mengembalikan null bila
     riwayat tidak lengkap — pemanggil lalu membaca ulang semua koleksi. */
  async function loadChanges(fromRev) {
    const meta = await loadMeta();
    const from = Number(fromRev || 0);
    if (meta.rev === from) return { rev: meta.rev, counters: meta.counters, docs: [], deleted: [] };
    if (meta.rev < from || meta.rev - from > 60) return null;
    const revs = [];
    for (let n = from + 1; n <= meta.rev; n += 1) revs.push(n);
    const changeDocs = await batchGet(revs.map((n) => docName("_meta", `chg-${n}`)));
    const last = new Map();
    for (const doc of changeDocs) {
      if (!doc) return null;
      const fields = decodeFields(doc.fields || {});
      if (!Array.isArray(fields.items)) return null;
      for (const entry of fields.items) {
        const [collection, id, kind] = String(entry).split("|");
        last.set(`${collection}|${id}`, { collection, id, kind });
      }
    }
    const wanted = [...last.values()].filter((item) => item.kind === "s");
    const docs = [];
    const deleted = [...last.values()].filter((item) => item.kind === "d").map(({ collection, id }) => ({ collection, id }));
    const fetched = await batchGet(wanted.map((item) => docName(item.collection, item.id)));
    wanted.forEach((item, index) => {
      if (fetched[index]) docs.push({ collection: item.collection, doc: decodeDocument(fetched[index]) });
      else deleted.push({ collection: item.collection, id: item.id });
    });
    return { rev: meta.rev, counters: meta.counters, docs, deleted };
  }

  /* Tulisan dikirim sebagai commit batch REST (maksimal 450 operasi per
     panggilan — di bawah batas 500 Firestore). Dokumen rev ditulis dengan
     precondition updateTime di batch pertama: bila perangkat lain sudah
     menulis lebih dulu, seluruh batch ditolak (CONFLICT) dan engine
     menjalankan ulang operasi di atas data terbaru. Tidak ada lagi dokumen
     yang diam-diam tertimpa atau id ganda antar perangkat. */
  async function commit(writes, counterState = null) {
    const revWrite = writes.find((w) => w.collection === "_meta" && String(w.id) === "rev");
    const dataWrites = writes.filter((w) => w.collection !== "_meta");
    const toFirestore = (write) => (write.op === "delete"
      ? { delete: docName(write.collection, write.id) }
      : { update: { name: docName(write.collection, write.id), fields: encodeFieldsTop(write.doc) } });
    const hasCounters = counterState && typeof counterState === "object" && Object.keys(counterState).length;
    const RESERVED = 3; /* rev + counters + chg */
    const size = CHUNK - RESERVED;
    const chunks = [];
    for (let index = 0; index < dataWrites.length; index += size) chunks.push(dataWrites.slice(index, index + size));
    if (!chunks.length) chunks.push([]);
    for (let c = 0; c < chunks.length; c += 1) {
      const body = { writes: [] };
      let revIndex = -1;
      if (c === 0 && revWrite) {
        revIndex = 0;
        body.writes.push({
          update: { name: docName("_meta", "rev"), fields: encodeFieldsTop(revWrite.doc) },
          currentDocument: revUpdateTime ? { updateTime: revUpdateTime } : { exists: false },
        });
      }
      for (const write of chunks[c]) body.writes.push(toFirestore(write));
      if (c === 0) {
        if (hasCounters) {
          body.writes.push({ update: { name: docName("_meta", "counters"), fields: encodeFieldsTop(counterState) } });
        }
        /* Daftar perubahan hanya untuk commit satu batch (utuh); commit
           besar membuat perangkat lain membaca ulang seluruh koleksi. */
        if (revWrite && chunks.length === 1) {
          const items = dataWrites.map((w) => `${w.collection}|${w.id}|${w.op === "delete" ? "d" : "s"}`);
          body.writes.push({
            update: {
              name: docName("_meta", `chg-${Number(revWrite.doc.rev)}`),
              fields: encodeFieldsTop({ rev: Number(revWrite.doc.rev), items }),
            },
          });
        }
      }
      if (!body.writes.length) continue;
      const payload = await requestJson(withKey(config, `${documentsPath}:commit`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (revIndex >= 0) {
        revUpdateTime = payload?.writeResults?.[revIndex]?.updateTime || null;
        if (!revUpdateTime) await loadMeta().catch(() => {});
      }
    }
  }

  function encodeFieldsTop(record) {
    const fields = {};
    for (const [key, value] of Object.entries(record || {})) {
      if (value === undefined) continue;
      fields[key] = encodeValue(value);
    }
    return fields;
  }

  async function remoteRev() {
    try {
      const meta = await loadMeta();
      return meta.rev;
    } catch {
      return null; /* tidak dapat memeriksa: pakai cache memori */
    }
  }

  return { kind: "firestore", config, loadAll, loadChanges, commit, remoteRev };
}
