/* Mesin data edisi Firestore: seluruh koleksi dimuat ke memori, validasi
   bisnis berjalan lokal (identik dengan server), lalu tulisan dikirim sebagai
   satu batch atomik. Antarmuka backend dipisahkan sehingga uji otomatis bisa
   memakai backend memori, sementara browser memakai Firestore asli. */

import { nowISO } from "./core.js";

export const COLLECTIONS = [
  "users", "products", "product_active_prices", "master_spec_values",
  "master_price_values", "sellers", "storage_locations", "seller_rits",
  "transactions", "location_transfers", "tally_headers", "tally_items",
  "payment_recap_headers", "payment_recap_items", "stock_opname",
  "stock_opname_items", "stock_period_closures", "stock_period_closure_items",
  "activity_log", "sync_outbox",
];

export function createEngine(backend) {
  const tables = new Map();
  for (const name of COLLECTIONS) tables.set(name, []);
  const counters = new Map();
  const meta = { rev: 0, loaded: false };
  let journal = null;

  const rows = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  const docId = (name, id) => `${name}/${id}`;

  /* Semua operasi (baca, tulis, muat ulang) berjalan satu per satu. Halaman
     memicu beberapa permintaan serentak, dan commit ke jaringan membutuhkan
     waktu; tanpa antrian, operasi yang tumpang tindih saling menimpa jurnal
     dan keadaan memori. */
  let queue = Promise.resolve();
  function exclusive(task) {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  let lastCheck = 0; /* waktu pemeriksaan rev jarak jauh terakhir */
  const CHECK_INTERVAL_MS = 1200;

  async function loadAllInner() {
    const payload = await backend.loadAll(COLLECTIONS);
    for (const name of COLLECTIONS) {
      // Abaikan dokumen tombstone (deleted:true) dari edisi 01 lama
      // agar data yang sudah dihapus tidak muncul lagi di UI.
      const list = (payload[name] || []).filter((row) => !row || row.deleted !== true);
      list.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
      tables.set(name, list);
      const maxId = list.reduce((acc, row) => Math.max(acc, Number(row.id) || 0), 0);
      const storedCounter = Number(payload?._counters?.[name] || 0);
      counters.set(name, Math.max(counters.get(name) || 0, maxId, storedCounter));
    }
    meta.rev = Number(payload?._meta?.rev || 0);
    meta.loaded = true;
    lastCheck = Date.now();
  }

  /* Terapkan perubahan dari perangkat lain tanpa membaca ulang semua
     koleksi (hemat kuota baca Firestore Spark). */
  function applyChanges(result) {
    for (const { collection, doc } of result.docs || []) {
      const list = rows(collection);
      const index = list.findIndex((row) => sameId(row.id, doc.id));
      // Tombstone dari edisi lain → perlakukan sebagai hapus
      if (doc && doc.deleted === true) {
        if (index >= 0) list.splice(index, 1);
        continue;
      }
      if (index >= 0) list[index] = doc;
      else list.push(doc);
      list.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    }
    for (const { collection, id } of result.deleted || []) {
      const list = rows(collection);
      const index = list.findIndex((row) => sameId(row.id, id));
      if (index >= 0) list.splice(index, 1);
    }
    for (const name of COLLECTIONS) {
      const maxId = rows(name).reduce((acc, row) => Math.max(acc, Number(row.id) || 0), 0);
      const stored = Number(result?.counters?.[name] || 0);
      counters.set(name, Math.max(counters.get(name) || 0, maxId, stored));
    }
    meta.rev = Number(result.rev || 0);
    lastCheck = Date.now();
  }

  /* Segarkan data lokal: coba jalur inkremental, bila tidak tersedia atau
     gagal untuk alasan apa pun, baca ulang seluruh koleksi. */
  async function refresh() {
    if (meta.loaded && backend.loadChanges) {
      try {
        const result = await backend.loadChanges(meta.rev);
        if (result) {
          applyChanges(result);
          return;
        }
      } catch {
        /* jatuh ke pembacaan penuh */
      }
    }
    await loadAllInner();
  }

  async function ensureReadyInner() {
    if (!meta.loaded) await loadAllInner();
    else if (backend.remoteRev) {
      /* Pemeriksaan rev dibatasi ~1 kali per detik (hemat kuota baca).
         Ketepatan penulisan tetap dijaga precondition rev saat commit. */
      if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return;
      const remote = await backend.remoteRev();
      lastCheck = Date.now();
      if (remote !== null && Number(remote || 0) !== Number(meta.rev || 0)) await refresh();
    }
  }

  const ensureReady = () => exclusive(ensureReadyInner);
  const loadAll = () => exclusive(loadAllInner);

  function nextId(name, count = 1) {
    const start = (counters.get(name) || 0) + 1;
    counters.set(name, start + count - 1);
    return start;
  }

  function record(name, doc) {
    if (journal) journal.push({ kind: "add", name, doc });
    const list = rows(name);
    list.push(doc);
    list.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  }

  /* Pencarian berdasarkan id: cocokkan angka ATAU teks persis agar dokumen
     asing ber-id UUID tetap dapat dirujuk (untuk dibersihkan). */
  function sameId(rowId, id) {
    if (Number(rowId) === Number(id) && Number.isFinite(Number(id))) return true;
    return String(rowId) === String(id);
  }

  function replace(name, id, doc) {
    const list = rows(name);
    const index = list.findIndex((row) => sameId(row.id, id));
    const previous = index >= 0 ? list[index] : null;
    if (journal) journal.push({ kind: "set", name, id, previous, doc });
    if (index >= 0) list[index] = doc;
    else list.push(doc);
  }

  function remove(name, id) {
    const list = rows(name);
    const index = list.findIndex((row) => sameId(row.id, id));
    if (index < 0) return;
    if (journal) journal.push({ kind: "del", name, id, previous: list[index] });
    list.splice(index, 1);
  }

  function clean(value) {
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = clean(item);
      return out;
    }
    return value;
  }

  /* Satu operasi API: validasi + tulis di memori, lalu commit ke backend.
     Bila terjadi galat, seluruh perubahan memori dibatalkan (journal). */
  function run(fn) {
    return exclusive(() => runWithRetry(fn));
  }

  async function runWithRetry(fn) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await runOnce(fn);
      } catch (error) {
        /* Perangkat lain menulis lebih dulu (rev berubah): perubahan lokal
           sudah dibatalkan; ambil data terbaru lalu jalankan ulang operasi
           dari awal agar id, stok, dan validasi memakai keadaan terkini. */
        if (error?.cause?.kind !== "CONFLICT" || attempt >= 5) {
          if (error?.cause?.kind === "CONFLICT") {
            throw new Error("Data sedang diubah pengguna lain. Muat ulang halaman lalu ulangi aksi ini.");
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 240));
        lastCheck = 0;
        await refresh();
      }
    }
  }

  async function runOnce(fn) {
    if (journal) throw new Error("Operasi store bersarang tidak didukung.");
    journal = [];
    const baseRev = Number(meta.rev || 0);
    const stamp = nowISO();
    const writes = [];
    const ctx = {
      now: stamp,
      insert(name, doc) {
        if (doc.id === undefined || doc.id === null) throw new Error(`insert ${name} tanpa id`);
        // Pertahankan id non-numerik (UUID dari edisi 01); angka tetap Number.
        const rawId = doc.id;
        const id = /^\d+$/.test(String(rawId)) ? Number(rawId) : rawId;
        const cleanDoc = clean({ ...doc, id });
        record(name, cleanDoc);
        writes.push({ op: "set", collection: name, id, doc: cleanDoc });
        return id;
      },
      update(name, id, patch) {
        const list = rows(name);
        const index = list.findIndex((row) => sameId(row.id, id));
        if (index < 0) throw new Error(`update ${name}/${id}: dokumen tidak ada`);
        const merged = clean({ ...list[index], ...patch, id: list[index].id });
        replace(name, id, merged);
        writes.push({ op: "set", collection: name, id: list[index].id, doc: merged });
        return list[index].id;
      },
      delete(name, id) {
        remove(name, id);
        /* id asli dipertahankan (bisa UUID dokumen asing). */
        writes.push({ op: "delete", collection: name, id });
      },
      allocate(name, count = 1) {
        return nextId(name, count);
      },
      /* Dipakai perbaikan seed: setelah dokumen pengguna rusak dihapus,
         penghitung diatur ulang agar id demo dimulai dari 1 kembali. */
      resetCounter(name) {
        counters.set(name, 0);
      },
      bumpRev() {
        meta.rev = Number(meta.rev || 0) + 1;
        writes.push({ op: "set", collection: "_meta", id: "rev", doc: { rev: meta.rev } });
      },
    };
    try {
      const result = await fn(ctx);
      if (writes.length && !writes.some((w) => w.collection === "_meta")) {
        meta.rev = Number(meta.rev || 0) + 1;
        writes.push({ op: "set", collection: "_meta", id: "rev", doc: { rev: meta.rev } });
      }
      if (writes.length) {
        const counterState = {};
        for (const [name, value] of counters.entries()) counterState[name] = value;
        await backend.commit(writes, counterState, { baseRev });
      }
      journal = null;
      return result;
    } catch (error) {
      meta.rev = baseRev; /* rev lokal ikut dibatalkan bersama perubahan */
      for (let i = journal.length - 1; i >= 0; i -= 1) {
        const entry = journal[i];
        const list = rows(entry.name);
        if (entry.kind === "add") {
          const index = list.findIndex((row) => row === entry.doc);
          if (index >= 0) list.splice(index, 1);
        } else if (entry.kind === "set") {
          const index = list.findIndex((row) => Number(row.id) === Number(entry.id));
          if (index >= 0) {
            if (entry.previous) list[index] = entry.previous;
            else list.splice(index, 1);
          }
        } else if (entry.kind === "del") {
          list.push(entry.previous);
          list.sort((a, b) => Number(a.id) - Number(b.id));
        }
      }
      journal = null;
      throw error;
    }
  }

  return {
    ensureReady,
    loadAll,
    run,
    all: (name) => rows(name),
    one: (name, id) => rows(name).find((row) => sameId(row.id, id)) || null,
    filter: (name, fn) => rows(name).filter(fn),
    where: (name, fn) => rows(name).find(fn) || null,
    counter: (name) => counters.get(name) || 0,
    rev: () => Number(meta.rev || 0),
    isLoaded: () => meta.loaded,
    docId,
    /* Utilitas untuk pengujian dan backup. */
    snapshot() {
      const out = { _meta: { rev: meta.rev } };
      for (const name of COLLECTIONS) out[name] = rows(name).map((row) => ({ ...row }));
      return out;
    },
    inject(payload) {
      for (const name of COLLECTIONS) {
        const list = payload[name] || [];
        list.sort((a, b) => Number(a.id) - Number(b.id));
        tables.set(name, list.map((row) => ({ ...row })));
        const maxId = list.reduce((acc, row) => Math.max(acc, Number(row.id) || 0), 0);
        counters.set(name, Math.max(counters.get(name) || 0, maxId));
      }
      meta.rev = Number(payload?._meta?.rev || 0);
      meta.loaded = true;
    },
  };
}

/* Backend memori: untuk uji diferensial dan mode demo tanpa jaringan. */
export function createMemoryBackend(initial) {
  const store = new Map();
  const changes = new Map(); /* rev -> { sets: [[koleksi,id]], dels: [[koleksi,id]] } */
  let rev = 0;
  let counterDoc = {};
  const findIndex = (list, id) => list.findIndex((row) => String(row.id) === String(id)
    || (Number.isFinite(Number(id)) && Number(row.id) === Number(id)));
  return {
    kind: "memory",
    async loadAll(collections) {
      const payload = { _meta: { rev }, _counters: { ...counterDoc } };
      for (const name of collections) payload[name] = (store.get(name) || []).map((row) => ({ ...row }));
      return payload;
    },
    async commit(writes, counterState, options = {}) {
      /* Kompare-dan-tukar atas rev: sama seperti precondition updateTime di Firestore. */
      if (options.baseRev !== undefined && Number(options.baseRev) !== rev) {
        throw new Error("Konflik rev.", { cause: { kind: "CONFLICT" } });
      }
      const record = { sets: [], dels: [] };
      let newRev = rev + 1;
      for (const write of writes) {
        if (write.collection === "_meta") {
          if (write.id === "rev") newRev = Number(write.doc.rev || newRev);
          continue;
        }
        const list = store.get(write.collection) || [];
        const index = findIndex(list, write.id);
        if (write.op === "delete") {
          if (index >= 0) list.splice(index, 1);
          record.dels.push([write.collection, write.id]);
        } else {
          if (index >= 0) list[index] = { ...write.doc };
          else list.push({ ...write.doc });
          record.sets.push([write.collection, write.id]);
        }
        list.sort((a, b) => Number(a.id) - Number(b.id));
        store.set(write.collection, list);
      }
      if (counterState) counterDoc = { ...counterState };
      rev = newRev;
      changes.set(rev, record);
    },
    async remoteRev() {
      return rev;
    },
    async loadChanges(fromRev) {
      if (Number(fromRev) === rev) return { rev, counters: { ...counterDoc }, docs: [], deleted: [] };
      if (Number(fromRev) > rev) return null;
      const last = new Map();
      for (let n = Number(fromRev) + 1; n <= rev; n += 1) {
        const record = changes.get(n);
        if (!record) return null;
        for (const [collection, id] of record.sets) last.set(`${collection}/${id}`, ["s", collection, id]);
        for (const [collection, id] of record.dels) last.set(`${collection}/${id}`, ["d", collection, id]);
      }
      const docs = [];
      const deleted = [];
      for (const [kind, collection, id] of last.values()) {
        const list = store.get(collection) || [];
        const index = findIndex(list, id);
        if (kind === "s" && index >= 0) docs.push({ collection, doc: { ...list[index] } });
        else deleted.push({ collection, id });
      }
      return { rev, counters: { ...counterDoc }, docs, deleted };
    },
    seed(payload) {
      rev = Number(payload?._meta?.rev || 0);
      for (const [name, list] of Object.entries(payload)) {
        if (name === "_meta") continue;
        store.set(name, list.map((row) => ({ ...row })));
      }
    },
    dump() {
      const out = { _meta: { rev } };
      for (const [name, list] of store.entries()) out[name] = list.map((row) => ({ ...row }));
      return out;
    },
  };
}
