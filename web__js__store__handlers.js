/* Port server/api.py: tabel rute, sesi, pembatas login, meta, dashboard.
   Modul ini bebas DOM sehingga dapat diuji di Node maupun browser. */

import {
  APP_EDITION, APP_NAME, APP_SUBTITLE, APP_VERSION, OPNAME_REASONS,
  AuthError, AppError, displayDate, todayISO, verifyPassword, usesDefaultPassword,
  checkNewPassword, hashPassword,
  PRODUCT_UNITS, IMPORT_PREFIX, MIN_PASSWORD_LENGTH,
} from "./core.js";
import {
  sellerDirectory, listRits, createRit, updateRit, deleteRit, listNotes,
  getNote, addNoteLine, updateNote, deleteNoteLine, createTally,
  createRecap, listTallies, getTally, cancelTally, listRecaps, getRecap,
  cancelRecap, stockGrouped, stockLotsDetail, stockAt, stockCard, lotCapacity,
  listOutgoing, recordOutgoing, getOutgoing, updateOutgoing, cancelOutgoing,
  listTransfers, recordTransfer, lockedThrough, listImports, createImport,
  parsePayload, getImport, updateImport, resolveSellerId, nocase,
} from "./flow.js";
import {
  activityReport, buildExport, dashboard, listSessions, nextPeriodInfo,
  recapReport, sellerSummary, sessionStatus, stockReport, tallyReport,
  transactionReport, transferReport, createSession, getSession,
  refreshItems, setCount, addFoundItem, fillUncountedAsSystem, approve,
  reopen, closePeriod, cancelDraft,
} from "./warehouse.js";
import {
  createLocation, createPrice, createProduct, createSeller, createSpec,
  createUser, createBackupPayload, currentUserRow, deleteLocation,
  deletePrice, deleteSeller, deleteUser, getProduct, listLocations, listPrices,
  listProducts, listSellers, listSpecs, listUsers, publicUser,
  purgeSyncedOutbox, requireAdmin, requirePrimary, resetTransactions,
  resetUserPassword, retrySync, syncStatus, toggleLocation, togglePrice,
  toggleProduct, toggleSeller, toggleSpec, updateLocation, updatePrice,
  updateProduct, updateSeller, updateSpec, updateUser, seedAccounts, DEMO_ACCOUNTS,
  demoPurgeDone, purgeDemoData,
} from "./registry.js";

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

function permissionsFor(user) {
  const isAdmin = user?.role === "admin";
  const primary = Boolean(user?.is_primary_admin);
  return {
    is_admin: isAdmin,
    is_primary: primary,
    manage_master: isAdmin,
    change_master_status: primary,
    manage_users: isAdmin,
    approve_opname: isAdmin,
    close_period: isAdmin,
    cancel_opname: isAdmin,
    reopen_opname: primary,
    reset_data: isAdmin,
    backup: isAdmin,
    activity: isAdmin,
    sync: isAdmin,
  };
}

function appInfo() {
  return {
    name: APP_NAME,
    subtitle: APP_SUBTITLE,
    version: APP_VERSION,
    edition: APP_EDITION,
    today: todayISO(),
    today_display: displayDate(todayISO()),
    year: new Date().getFullYear(),
  };
}

class SessionStore {
  constructor(storage) {
    this.storage = storage || null;
    this.sessions = new Map(Object.entries(this.storage?.read("br_sessions") || {}));
  }

  persist() {
    this.storage?.write("br_sessions", Object.fromEntries(this.sessions));
  }

  create(userId) {
    const token = randomToken(32);
    const now = Date.now() / 1000;
    this.sessions.set(token, { user_id: Number(userId), created_at: now, last_seen: now });
    this.persist();
    return token;
  }

  get(token) {
    if (!token) return null;
    const now = Date.now() / 1000;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (now - session.last_seen > SESSION_TTL_SECONDS) {
      this.sessions.delete(token);
      this.persist();
      return null;
    }
    session.last_seen = now;
    return session;
  }

  revoke(token) {
    if (!token) return;
    this.sessions.delete(token);
    this.persist();
  }

  revokeUser(userId, exceptToken = null) {
    let removed = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (Number(session.user_id) === Number(userId) && token !== exceptToken) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    this.persist();
    return removed;
  }
}

function randomToken(bytes) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ aplikasi */

export function createApp(engine, { storage = null, autoSeed = true } = {}) {
  const sessions = new SessionStore(storage);
  let seeded = false;

  const routes = [];
  const route = (method, pattern, handler, options = {}) => {
    routes.push({ method: method.toUpperCase(), pattern: new RegExp(`^${pattern}$`), handler, ...options });
  };

  const qInt = (query, name, required = false, defaultValue = null) => {
    const value = query[name];
    if (value === undefined || value === null || value === "") {
      if (required) throw new AppError(`Parameter ${name} wajib diisi.`);
      return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new AppError(`Parameter ${name} harus berupa angka.`);
    return parsed;
  };

  const qStr = (query, name, defaultValue = "") => String(query[name] ?? (defaultValue || "")).trim();

  const bodyDict = (body) => {
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
    if (body === null || body === undefined || body === "") return {};
    throw new AppError("Payload harus berupa objek JSON.");
  };

  const bodyInt = (body, name, required = true, defaultValue = null) => {
    const dict = bodyDict(body);
    const value = dict[name];
    if (value === undefined || value === null || value === "") {
      if (required) throw new AppError(`${name} wajib diisi.`);
      return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new AppError(`${name} harus berupa angka bulat.`);
    return parsed;
  };

  const bodyList = (body, name) => {
    const dict = bodyDict(body);
    const value = dict[name];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new AppError(`${name} harus berupa daftar.`);
    return value;
  };

  const currentUserOf = (d, token) => {
    const session = sessions.get(token);
    if (!session) return null;
    const row = d.one("users", Number(session.user_id));
    if (!row || row.active !== 1) {
      sessions.revoke(token);
      return null;
    }
    return row;
  };

  /* Penanaman awal + perbaikan mandiri. Empat kondisi ditangani:
     1. Koleksi users kosong → tanam akun login saja (tanpa data contoh).
     2. Tidak ada satu pun akun valid (id bulat positif + password_hash format
        aplikasi + aktif) → hapus semua dokumen users lalu tanam ulang. Penyebab
        umum: dokumen sisa/uji tanpa password_hash, atau hash warisan edisi lama
        (SHA-256 polos) yang tidak dapat diverifikasi aplikasi ini.
     3. Ada akun valid tetapi ada dokumen ASING (id UUID, tanpa password_hash,
        atau format hash dari aplikasi lain) → hapus dokumen asing
        saja; dokumen asing bisa menutupi akun asli saat pencarian username.
     4. Data contoh peninggalan versi lama masih tersimpan → dibersihkan
        sekali (penanda di log aktivitas), sisanya dibiarkan utuh.
     Penghapusan (tahap 1) dan penanaman (tahap 2) sengaja dipisah agar satu
     batch tidak pernah menghapus dan menulis dokumen yang sama. */
  const PASSWORD_HASH_SHAPE = /^pbkdf2_sha256\$\d+\$[^$]+\$[^$]+$/;

  function passwordHashUsable(value) {
    return PASSWORD_HASH_SHAPE.test(String(value || ""));
  }

  function userIsGarbage(row) {
    const idNum = Number(row.id);
    const validId = Number.isSafeInteger(idNum) && idNum > 0;
    return !validId || !passwordHashUsable(row.password_hash);
  }

  async function ensureSeeded() {
    if (seeded || !autoSeed) return;
    const users = engine.all("users");
    const validAccounts = users.filter((row) => !userIsGarbage(row)
      && row.active === 1 && !row.deleted);
    const hasUsable = validAccounts.length > 0;
    if (users.length && (!hasUsable || users.some(userIsGarbage))) {
      await engine.run(async (ctx) => {
        /* Salin daftar dahulu: ctx.delete memodifikasi daftar yang sama. */
        const doomed = hasUsable
          ? users.filter(userIsGarbage).map((row) => row.id)
          : users.map((row) => row.id);
        for (const id of doomed) ctx.delete("users", id);
        if (!hasUsable) {
          ctx.resetCounter("users");
          ctx.bumpRev();
        }
      });
    }
    await engine.run(async (ctx) => {
      const d = makeHandle(engine, ctx);
      /* Sekali saja: bersihkan data contoh peninggalan versi sebelumnya agar
         basis data mulai kosong, lalu tanam akun login bila memang belum ada. */
      if (!demoPurgeDone(d)) purgeDemoData(d);
      if (!d.all("users").length) await seedAccounts(d);
    });
    seeded = true;
  }

  function makeHandle(engineRef, ctx) {
    return {
      now: ctx.now,
      insert: ctx.insert,
      update: ctx.update,
      delete: ctx.delete,
      allocate: ctx.allocate,
      resetCounter: ctx.resetCounter,
      all: engineRef.all,
      one: engineRef.one,
      filter: engineRef.filter,
      where: engineRef.where,
    };
  }

  /* Semua handler menerima (d, ctxApi, params) dan mengembalikan data JSON. */
  const app = { sessions };

  /* Pemulihan akun awal. Akun bawaan (admin / administrator) yang BELUM PERNAH
     dipakai masuk dan belum pernah diganti passwordnya selalu dapat dibuka
     dengan password awalnya — meskipun database lama menyimpan hash dari
     versi sebelumnya (mis. admin/123). Begitu akun pernah berhasil masuk,
     password yang tersimpan dihormati sepenuhnya. */
  async function healDefaultAccount(d, username, password) {
    const key = username.trim().toLowerCase();
    if (!usesDefaultPassword(key, password)) return;
    const def = DEMO_ACCOUNTS.find((item) => item[0] === key);
    if (!def) return;
    const rows = d.filter("users", (item) => String(item.username).toLowerCase() === key);
    if (!rows.length) {
      /* Hanya Administrator Utama yang tidak mungkin dihapus sah-nya; akun
         admin yang sengaja dihapus tidak dihidupkan kembali. */
      if (!def[4]) return;
      const userId = d.allocate("users");
      d.insert("users", {
        id: userId, username: def[0], full_name: def[1],
        password_hash: await hashPassword(password), role: def[3],
        is_primary_admin: def[4], active: 1, created_at: d.now, last_login: null,
      });
      return;
    }
    const target = rows.find((item) => item.active === 1);
    if (!target || target.password_custom || target.last_login) return;
    if (passwordHashUsable(target.password_hash) && await verifyPassword(password, target.password_hash)) return;
    d.update("users", target.id, { password_hash: await hashPassword(password) });
  }

  const loginHandler = async (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) throw new AuthError("Username dan password wajib diisi.");
    await healDefaultAccount(d, username, password);
    /* Bila ada duplikat username (misalnya dokumen sisa aplikasi lain tanpa
       password_hash), utamakan baris yang benar-benar dapat diautentikasi. */
    const candidates = d.filter("users", (item) => String(item.username).toLowerCase() === username.toLowerCase()
      && item.active === 1 && !item.deleted);
    const ordered = [
      ...candidates.filter((item) => passwordHashUsable(item.password_hash)),
      ...candidates.filter((item) => !passwordHashUsable(item.password_hash)),
    ];
    let row = null;
    for (const item of ordered) {
      if (await verifyPassword(password, item.password_hash)) { row = item; break; }
    }
    if (!row) throw new AuthError("Username atau password salah.");
    const token = sessions.create(Number(row.id));
    return {
      __token: token,
      __login_user_id: Number(row.id),
      user: publicUser(row),
      permissions: permissionsFor(row),
      app: appInfo(),
    };
  };

  const sessionHandler = (d, ctxApi) => ({
    user: publicUser(ctxApi.user),
    permissions: permissionsFor(ctxApi.user),
    app: appInfo(),
  });

  const logoutHandler = (d, ctxApi) => {
    log2(d, Number(ctxApi.user.id), "LOGOUT", `user=${ctxApi.user.username}`, "users", Number(ctxApi.user.id));
    sessions.revoke(ctxApi.token);
    return { logged_out: true };
  };

  const changePasswordHandler = async (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    const row = d.one("users", Number(ctxApi.user.id));
    if (!row || row.active !== 1) throw new AuthError("Sesi tidak valid.");
    if (!(await verifyPassword(String(body.old_password || ""), row.password_hash))) {
      throw new AppError("Password lama salah.");
    }
    checkNewPassword(row.username, String(body.new_password || ""), String(body.confirm_password || ""), String(body.old_password || ""));
    d.update("users", Number(row.id), {
      password_hash: await hashPassword(String(body.new_password || "")),
      password_custom: 1,
    });
    log2(d, Number(row.id), "GANTI_PASSWORD", `user=${row.username}`, "users", Number(row.id));
    const revoked = sessions.revokeUser(Number(row.id), ctxApi.token);
    const fresh = d.one("users", Number(row.id));
    return {
      user: publicUser(fresh),
      revoked_sessions: revoked,
      permissions: permissionsFor(fresh),
    };
  };

  const metaHandler = (d, ctxApi) => {
    const products = listProducts(d, { includeInactive: false, localOnly: true });
    const sellers = listSellers(d, { includeInactive: false });
    const locations = listLocations(d, { includeInactive: false });
    const specs = listSpecs(d, { includeInactive: false });
    const prices = listPrices(d, { includeInactive: false });
    const period = nextPeriodInfo(d);
    if (period.unclosed) {
      const row = period.unclosed;
      row.label_status = sessionStatus(row);
      row.period_start_display = displayDate(String(row.period_start).slice(0, 10));
      row.period_end_display = displayDate(String(row.period_end).slice(0, 10));
    }
    const locked = lockedThrough(d);
    const counts = {
      active_tallies: d.filter("tally_headers", (row) => row.status === "POSTED").length,
      active_recaps: d.filter("payment_recap_headers", (row) => row.status === "AKTIF").length,
      unclosed_opname: period.unclosed ? Number(period.unclosed.id) : null,
      products: products.length,
    };
    return {
      app: appInfo(),
      user: publicUser(ctxApi.user),
      permissions: permissionsFor(ctxApi.user),
      masters: {
        products: products.map((row) => {
          const picked = {};
          for (const key of ["id", "code", "name", "unit", "spec_t", "spec_l", "spec_p", "active_price", "purchase_price", "min_stock"]) {
            picked[key] = row[key];
          }
          return picked;
        }),
        sellers: sellers.map((row) => ({ id: row.id, name: row.name, city: row.city || "" })),
        locations: locations.map((row) => ({ code: row.code, name: row.name })),
        specs,
        prices: prices.map((row) => Number(row.price)),
      },
      constants: {
        opname_reasons: [...OPNAME_REASONS],
        product_units: [...PRODUCT_UNITS],
        import_prefix: IMPORT_PREFIX,
        min_password_length: MIN_PASSWORD_LENGTH,
      },
      lock: {
        locked_through: locked,
        locked_through_display: locked ? displayDate(locked) : null,
      },
      period,
      counts,
    };
  };

  const reportFilters = (ctxApi) => ({
    start: qStr(ctxApi.query, "start"),
    end: qStr(ctxApi.query, "end"),
    seller_id: qInt(ctxApi.query, "seller_id"),
    product_id: qInt(ctxApi.query, "product_id"),
    location: qStr(ctxApi.query, "location"),
    query: qStr(ctxApi.query, "query"),
    cutoff: qStr(ctxApi.query, "cutoff"),
    thickness: qStr(ctxApi.query, "thickness"),
    kind: qStr(ctxApi.query, "kind") || "MASUK",
    user_id: qInt(ctxApi.query, "user_id"),
    limit: Number(qStr(ctxApi.query, "limit") || 500),
  });

  /* ------------------------------------------------------------ rute */

  route("GET", "/api/health", (d) => ({ status: "ok", app: appInfo() }), { authRequired: false });
  route("POST", "/api/auth/login", loginHandler, { authRequired: false });
  route("POST", "/api/auth/logout", logoutHandler);
  route("GET", "/api/auth/session", sessionHandler);
  route("POST", "/api/auth/change-password", changePasswordHandler);
  route("GET", "/api/meta", metaHandler);
  route("GET", "/api/dashboard", (d, ctxApi) => {
    const data = dashboard(d);
    data.permissions = permissionsFor(ctxApi.user);
    data.user = publicUser(ctxApi.user);
    data.app = appInfo();
    return data;
  });

  route("GET", "/api/sellers/directory", (d) => ({ sellers: sellerDirectory(d) }));
  route("GET", "/api/rits", (d, ctxApi) => {
    const sellerId = qInt(ctxApi.query, "seller_id", true);
    const month = qStr(ctxApi.query, "month") || todayISO().slice(0, 7);
    return { month, rits: listRits(d, sellerId, month) };
  });
  route("POST", "/api/rits", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    return createRit(d, ctxApi.user.id, bodyInt(ctxApi.body, "seller_id"), body.rit_number, body.date,
      String(body.delivery_number || ""), String(body.note || ""));
  });
  route("PUT", "/api/rits/(\\d+)", (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    return updateRit(d, ctxApi.user.id, Number(m[1]), body.rit_number, body.date,
      String(body.delivery_number || ""), String(body.note || ""));
  });
  route("DELETE", "/api/rits/(\\d+)", (d, ctxApi, m) => deleteRit(d, ctxApi.user.id, Number(m[1])));
  route("GET", "/api/rits/(\\d+)/notes", (d, ctxApi, m) => listNotes(d, Number(m[1])));
  route("GET", "/api/rits/(\\d+)/notes/([^/]+)", (d, ctxApi, m) => getNote(d, Number(m[1]), decodeURIComponent(m[2])));
  route("POST", "/api/rits/(\\d+)/notes", (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    return addNoteLine(d, ctxApi.user.id, Number(m[1]), body.note, body.date, body.thickness,
      body.price, String(body.location || ""), bodyInt(ctxApi.body, "product_id"),
      body.width, body.length, body.qty, String(body.line_note || ""));
  });
  route("PUT", "/api/rits/(\\d+)/notes/([^/]+)", (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    return updateNote(d, ctxApi.user.id, Number(m[1]), decodeURIComponent(m[2]), body.date,
      body.thickness, body.price, String(body.location || ""), body.new_note);
  });
  route("DELETE", "/api/note-lines/(\\d+)", (d, ctxApi, m) => deleteNoteLine(d, ctxApi.user.id, Number(m[1])));
  route("POST", "/api/rits/(\\d+)/notes/([^/]+)/tally", (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    return createTally(d, ctxApi.user.id, Number(m[1]), decodeURIComponent(m[2]),
      bodyList(ctxApi.body, "items"), String(body.signature || ""));
  });
  route("POST", "/api/rits/(\\d+)/notes/([^/]+)/recap", (d, ctxApi, m) => createRecap(d, ctxApi.user.id, Number(m[1]), decodeURIComponent(m[2])));
  route("GET", "/api/tallies", (d, ctxApi) => ({
    tallies: listTallies(d, qInt(ctxApi.query, "seller_id"), qStr(ctxApi.query, "start"),
      qStr(ctxApi.query, "end"), qStr(ctxApi.query, "query"), qStr(ctxApi.query, "status")),
  }));
  route("GET", "/api/tallies/(\\d+)", (d, ctxApi, m) => getTally(d, Number(m[1])));
  route("POST", "/api/tallies/(\\d+)/cancel", (d, ctxApi, m) => cancelTally(d, ctxApi.user.id, Number(m[1]), String(bodyDict(ctxApi.body).reason || "")));
  route("GET", "/api/recaps", (d, ctxApi) => ({
    recaps: listRecaps(d, qInt(ctxApi.query, "seller_id"), qStr(ctxApi.query, "start"),
      qStr(ctxApi.query, "end"), qStr(ctxApi.query, "query"), qStr(ctxApi.query, "status")),
  }));
  route("GET", "/api/recaps/(\\d+)", (d, ctxApi, m) => getRecap(d, Number(m[1])));
  route("POST", "/api/recaps/(\\d+)/cancel", (d, ctxApi, m) => cancelRecap(d, ctxApi.user.id, Number(m[1]), String(bodyDict(ctxApi.body).reason || "")));

  route("GET", "/api/stock", (d, ctxApi) => {
    const rows = stockGrouped(d, qStr(ctxApi.query, "query"), qStr(ctxApi.query, "location"), qStr(ctxApi.query, "thickness"));
    for (const row of rows) row.location_count = Object.keys(row.locations || {}).length;
    return {
      rows,
      totals: {
        qty: round4(rows.reduce((acc, row) => acc + Number(row.stock || 0), 0)),
        m3: round6(rows.reduce((acc, row) => acc + Number(row.m3 || 0), 0)),
        items: rows.length,
      },
      locked_through: lockedThrough(d),
    };
  });
  route("GET", "/api/stock/lots", (d, ctxApi) => {
    const productId = qInt(ctxApi.query, "product_id", true);
    const size = qStr(ctxApi.query, "size");
    const location = qStr(ctxApi.query, "location");
    if (!size) throw new AppError("Parameter size wajib diisi.");
    const lots = stockLotsDetail(d, productId, size, location);
    const row = d.one("products", productId) || {};
    return {
      lots,
      product: { id: row.id, code: row.code, name: row.name, unit: row.unit, purchase_price: row.purchase_price },
      on_hand: stockAt(d, productId, size, location),
      location,
    };
  });
  route("GET", "/api/stock-card", (d, ctxApi) => {
    const productId = qInt(ctxApi.query, "product_id", true);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const start = qStr(ctxApi.query, "start") || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const end = qStr(ctxApi.query, "end") || todayISO();
    return stockCard(d, productId, qStr(ctxApi.query, "size"), qStr(ctxApi.query, "location"), start, end);
  });
  route("GET", "/api/outgoing", (d, ctxApi) => {
    const rows = listOutgoing(d, qStr(ctxApi.query, "start"), qStr(ctxApi.query, "end"), qStr(ctxApi.query, "query"));
    return {
      rows,
      totals: {
        count: rows.length,
        qty: round4(rows.reduce((acc, row) => acc + Number(row.qty || 0), 0)),
      },
      locked_through: lockedThrough(d),
    };
  });
  route("POST", "/api/outgoing", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    return recordOutgoing(d, ctxApi.user.id, bodyInt(ctxApi.body, "source_id"), String(body.location || ""),
      body.qty, body.date, String(body.note || ""));
  });
  route("GET", "/api/outgoing/(\\d+)", (d, ctxApi, m) => {
    const row = getOutgoing(d, Number(m[1]));
    row.m3_display = Number(row.m3).toFixed(6);
    row.max_qty = null;
    if (row.source_trx_id) {
      try {
        const lot = lotCapacity(d, Number(row.source_trx_id), row.location || "");
        row.max_qty = round4(Number(lot.remaining || 0) + Number(row.qty || 0));
        row.lot_remaining = round4(Number(lot.remaining || 0));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    return row;
  });
  route("PUT", "/api/outgoing/(\\d+)", (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    return updateOutgoing(d, ctxApi.user.id, Number(m[1]), body.qty, body.date,
      String(body.note || ""), String(body.location || ""));
  });
  route("POST", "/api/outgoing/cancel", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    if (!Array.isArray(body.ids)) throw new AppError("ids harus berupa daftar transaksi.");
    return cancelOutgoing(d, ctxApi.user.id, body.ids, String(body.reason || ""));
  });
  route("GET", "/api/transfers", (d, ctxApi) => {
    const rows = listTransfers(d, qStr(ctxApi.query, "start"), qStr(ctxApi.query, "end"), qStr(ctxApi.query, "query"));
    return {
      rows,
      totals: {
        count: rows.length,
        qty: round4(rows.reduce((acc, row) => acc + Number(row.qty || 0), 0)),
        m3: round6(rows.reduce((acc, row) => acc + Number(row.m3 || 0), 0)),
      },
    };
  });
  route("POST", "/api/transfers", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    return recordTransfer(d, ctxApi.user.id, bodyInt(ctxApi.body, "product_id"), String(body.size || ""),
      String(body.from_location || ""), String(body.to_location || ""), body.qty, body.date, String(body.note || ""));
  });

  route("GET", "/api/imports", (d, ctxApi) => listImports(d, qStr(ctxApi.query, "start"), qStr(ctxApi.query, "end"), qStr(ctxApi.query, "query")));
  route("POST", "/api/imports", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    let data;
    if (body.fields && typeof body.fields === "object") data = body.fields;
    else if (body.payload !== undefined && body.payload !== null) data = parsePayload(body.payload);
    else data = body;
    return createImport(d, ctxApi.user.id, data);
  });
  route("POST", "/api/imports/parse", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    const payload = body.payload;
    if (payload === null || payload === undefined || payload === "") {
      throw new AppError("Isi payload barcode/dokumen terlebih dahulu.");
    }
    return { parsed: parsePayload(payload) };
  });
  route("GET", "/api/imports/export", (d, ctxApi) => downloadResult(d, ctxApi, "imports"));
  route("GET", "/api/imports/(\\d+)", (d, ctxApi, m) => getImport(d, Number(m[1])));
  route("PUT", "/api/imports/(\\d+)", (d, ctxApi, m) => updateImport(d, ctxApi.user.id, Number(m[1]), bodyDict(ctxApi.body)));

  route("GET", "/api/opname", (d, ctxApi) => {
    const sessionsList = listSessions(d);
    const info = nextPeriodInfo(d);
    if (info.unclosed) {
      const row = info.unclosed;
      row.label_status = sessionStatus(row);
      row.period_start_display = displayDate(String(row.period_start).slice(0, 10));
      row.period_end_display = displayDate(String(row.period_end).slice(0, 10));
    }
    return {
      sessions: sessionsList,
      next: info,
      locked_through: lockedThrough(d),
      permissions: permissionsFor(ctxApi.user),
    };
  });
  route("POST", "/api/opname", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    const opnameId = createSession(d, ctxApi.user.id, body.start, body.end);
    return getSession(d, opnameId);
  });
  route("GET", "/api/opname/(\\d+)", (d, ctxApi, m) => {
    const data = getSession(d, Number(m[1]));
    data.permissions = permissionsFor(ctxApi.user);
    return data;
  });
  route("POST", "/api/opname/(\\d+)/refresh", (d, ctxApi, m) => {
    const result = refreshItems(d, ctxApi.user.id, Number(m[1]));
    result.session = getSession(d, Number(m[1]));
    return result;
  });
  route("PUT", "/api/opname/(\\d+)/items/(\\d+)", (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    return setCount(d, ctxApi.user.id, Number(m[1]), Number(m[2]), body.physical_qty,
      String(body.reason || ""), String(body.note || ""));
  });
  route("POST", "/api/opname/(\\d+)/items", (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    return addFoundItem(d, ctxApi.user.id, Number(m[1]), bodyInt(ctxApi.body, "product_id"),
      String(body.size || ""), String(body.location || ""), body.physical_qty,
      String(body.reason || "Barang temuan"), String(body.note || ""));
  });
  route("POST", "/api/opname/(\\d+)/fill", (d, ctxApi, m) => fillUncountedAsSystem(d, ctxApi.user.id, Number(m[1])));
  route("POST", "/api/opname/(\\d+)/approve", (d, ctxApi, m) => {
    requireAdmin(ctxApi.user);
    return approve(d, ctxApi.user.id, Number(m[1]));
  });
  route("POST", "/api/opname/(\\d+)/reopen", (d, ctxApi, m) => {
    requirePrimary(ctxApi.user);
    return reopen(d, ctxApi.user.id, Number(m[1]), String(bodyDict(ctxApi.body).reason || ""));
  });
  route("POST", "/api/opname/(\\d+)/close", (d, ctxApi, m) => {
    requireAdmin(ctxApi.user);
    return closePeriod(d, ctxApi.user.id, Number(m[1]));
  });
  route("POST", "/api/opname/(\\d+)/cancel", (d, ctxApi, m) => {
    requireAdmin(ctxApi.user);
    return cancelDraft(d, ctxApi.user.id, Number(m[1]));
  });

  route("GET", "/api/reports/transactions", (d, ctxApi) => {
    const f = reportFilters(ctxApi);
    return transactionReport(d, f.start, f.end, f.kind, f.seller_id, f.product_id, f.location, f.query);
  });
  route("GET", "/api/reports/stock", (d, ctxApi) => {
    const f = reportFilters(ctxApi);
    return stockReport(d, f.cutoff, f.query, f.location, f.thickness);
  });
  route("GET", "/api/reports/sellers", (d, ctxApi) => {
    const f = reportFilters(ctxApi);
    return sellerSummary(d, f.start, f.end);
  });
  route("GET", "/api/reports/recaps", (d, ctxApi) => {
    const f = reportFilters(ctxApi);
    return recapReport(d, f.start, f.end, f.seller_id);
  });
  route("GET", "/api/reports/tallies", (d, ctxApi) => {
    const f = reportFilters(ctxApi);
    return tallyReport(d, f.start, f.end, f.seller_id);
  });
  route("GET", "/api/reports/transfers", (d, ctxApi) => {
    const f = reportFilters(ctxApi);
    return transferReport(d, f.start, f.end, f.query);
  });
  route("GET", "/api/reports/imports", (d, ctxApi) => {
    const f = reportFilters(ctxApi);
    return listImports(d, f.start, f.end, f.query);
  });
  route("GET", "/api/reports/activity", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    const f = reportFilters(ctxApi);
    return activityReport(d, f.start, f.end, qInt(ctxApi.query, "user_id"), f.query, f.limit);
  });
  route("GET", "/api/exports/([a-z-]+)", (d, ctxApi, m) => exportResult(d, ctxApi, m[1]));

  route("GET", "/api/master/products", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    return {
      products: listProducts(d, {
        includeInactive: qStr(ctxApi.query, "include_inactive") !== "0",
        query: qStr(ctxApi.query, "query"),
      }),
    };
  });
  route("POST", "/api/master/products", (d, ctxApi) => createProduct(d, ctxApi.user.id, bodyDict(ctxApi.body)));
  route("PUT", "/api/master/products/(\\d+)", (d, ctxApi, m) => updateProduct(d, ctxApi.user.id, Number(m[1]), bodyDict(ctxApi.body)));
  route("POST", "/api/master/products/(\\d+)/toggle", (d, ctxApi, m) => toggleProduct(d, ctxApi.user.id, Number(m[1])));

  route("GET", "/api/master/sellers", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    return {
      sellers: listSellers(d, {
        includeInactive: qStr(ctxApi.query, "include_inactive") !== "0",
        query: qStr(ctxApi.query, "query"),
      }),
    };
  });
  route("POST", "/api/master/sellers", (d, ctxApi) => createSeller(d, ctxApi.user.id, bodyDict(ctxApi.body)));
  route("PUT", "/api/master/sellers/([^/]+)", (d, ctxApi, m) => updateSeller(d, ctxApi.user.id, m[1], bodyDict(ctxApi.body)));
  route("POST", "/api/master/sellers/([^/]+)/toggle", (d, ctxApi, m) => toggleSeller(d, ctxApi.user.id, m[1]));
  route("DELETE", "/api/master/sellers/([^/]+)", (d, ctxApi, m) => deleteSeller(d, ctxApi.user.id, m[1]));

  route("GET", "/api/master/locations", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    return { locations: listLocations(d, { includeInactive: qStr(ctxApi.query, "include_inactive") !== "0" }) };
  });
  route("POST", "/api/master/locations", (d, ctxApi) => createLocation(d, ctxApi.user.id, bodyDict(ctxApi.body)));
  route("PUT", "/api/master/locations/(\\d+)", (d, ctxApi, m) => updateLocation(d, ctxApi.user.id, Number(m[1]), bodyDict(ctxApi.body)));
  route("POST", "/api/master/locations/(\\d+)/toggle", (d, ctxApi, m) => toggleLocation(d, ctxApi.user.id, Number(m[1])));
  route("DELETE", "/api/master/locations/([^/]+)", (d, ctxApi, m) => deleteLocation(d, ctxApi.user.id, m[1]));

  route("GET", "/api/master/specs", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    return listSpecs(d, { includeInactive: qStr(ctxApi.query, "include_inactive") !== "0" });
  });
  route("POST", "/api/master/specs", (d, ctxApi) => createSpec(d, ctxApi.user.id, bodyDict(ctxApi.body)));
  route("PUT", "/api/master/specs/(\\d+)", (d, ctxApi, m) => updateSpec(d, ctxApi.user.id, Number(m[1]), bodyDict(ctxApi.body)));
  route("POST", "/api/master/specs/(\\d+)/toggle", (d, ctxApi, m) => toggleSpec(d, ctxApi.user.id, Number(m[1])));

  route("GET", "/api/master/prices", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    return { prices: listPrices(d, { includeInactive: qStr(ctxApi.query, "include_inactive") !== "0" }) };
  });
  route("POST", "/api/master/prices", (d, ctxApi) => createPrice(d, ctxApi.user.id, bodyDict(ctxApi.body)));
  route("PUT", "/api/master/prices/(\\d+)", (d, ctxApi, m) => updatePrice(d, ctxApi.user.id, Number(m[1]), bodyDict(ctxApi.body)));
  route("POST", "/api/master/prices/(\\d+)/toggle", (d, ctxApi, m) => togglePrice(d, ctxApi.user.id, Number(m[1])));
  route("DELETE", "/api/master/prices/([^/]+)", (d, ctxApi, m) => deletePrice(d, ctxApi.user.id, m[1]));

  route("GET", "/api/master/users", (d, ctxApi) => ({ users: listUsers(d, ctxApi.user) }));
  route("POST", "/api/master/users", (d, ctxApi) => createUser(d, ctxApi.user, bodyDict(ctxApi.body)));
  route("PUT", "/api/master/users/(\\d+)", async (d, ctxApi, m) => {
    const result = await updateUser(d, ctxApi.user, Number(m[1]), bodyDict(ctxApi.body));
    if (!result.active) sessions.revokeUser(Number(m[1]));
    return result;
  });
  route("POST", "/api/master/users/(\\d+)/reset-password", async (d, ctxApi, m) => {
    const result = await resetUserPassword(d, ctxApi.user, Number(m[1]), bodyDict(ctxApi.body));
    sessions.revokeUser(Number(m[1]));
    return result;
  });
  route("DELETE", "/api/master/users/(\\d+)", async (d, ctxApi, m) => {
    const body = bodyDict(ctxApi.body);
    const result = await deleteUser(d, ctxApi.user, Number(m[1]), String(body.password || ""));
    sessions.revokeUser(Number(m[1]));
    return result;
  });

  route("GET", "/api/admin/activity", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    return activityReport(d, qStr(ctxApi.query, "start"), qStr(ctxApi.query, "end"),
      qInt(ctxApi.query, "user_id"), qStr(ctxApi.query, "query"), Number(qStr(ctxApi.query, "limit") || 500));
  });
  route("GET", "/api/admin/sync", (d, ctxApi) => {
    requireAdmin(ctxApi.user);
    return syncStatus(d);
  });
  route("POST", "/api/admin/sync/retry", (d, ctxApi) => retrySync(d, ctxApi.user));
  route("POST", "/api/admin/sync/purge", (d, ctxApi) => purgeSyncedOutbox(d, ctxApi.user));
  route("GET", "/api/admin/backup", (d, ctxApi) => backupResult(d, ctxApi));
  route("POST", "/api/admin/reset-transactions", (d, ctxApi) => {
    const body = bodyDict(ctxApi.body);
    return resetTransactions(d, ctxApi.user, String(body.password || ""), String(body.confirmation || ""));
  });

  function log2(d, userId, action, detail, entity, entityId) {
    const logId = d.allocate("activity_log");
    d.insert("activity_log", {
      id: logId, event_time: d.now, user_id: userId ? Number(userId) : null, action, detail: detail || null,
    });
    const outboxId = d.allocate("sync_outbox");
    d.insert("sync_outbox", {
      id: outboxId, created_at: d.now, entity, entity_id: entityId, action, status: "SYNCED", note: null,
    });
  }

  function lotCapacityOf(d, sourceId, location) {
    const lot = d.one("transactions", Number(sourceId));
    if (!lot) throw new AppError("Lot barang masuk sumber tidak ditemukan.");
    const { normalizeSize, sizeDisplay } = sizeHelpers();
    const normalized = normalizeSize(lot.trx_size);
    const remaining = round4(Number(lot.qty || 0)
      - d.filter("transactions", (row) => Number(row.source_trx_id) === Number(sourceId) && row.trx_type === "KELUAR")
        .reduce((acc, row) => acc + Number(row.qty || 0), 0));
    const map = stockMapOf(d);
    const stock = map.get(`${Number(lot.product_id)}|${normalized}|${String(location || "").trim()}`) || 0;
    return {
      ...lot, size: normalized, size_display: sizeDisplay(normalized),
      remaining, location_stock: round4(stock),
      capacity: round4(Math.max(0, Math.min(remaining, stock))),
    };
  }

  function exportResult(d, ctxApi, name) {
    if (["activity", "aktivitas"].includes(String(name))) requireAdmin(ctxApi.user);
    const params = {};
    for (const [key, value] of Object.entries(ctxApi.query || {})) {
      if (value !== null && value !== undefined && value !== "") params[key] = value;
    }
    const [filename, content] = buildExport(d, name, params);
    return { __download__: { filename, content, mime: "text/csv;charset=utf-8" } };
  }

  function downloadResult(d, ctxApi, name) {
    return exportResult(d, ctxApi, name);
  }

  function backupResult(d, ctxApi) {
    requireAdmin(ctxApi.user);
    const payload = createBackupPayload(d);
    log2(d, Number(ctxApi.user.id), "BACKUP_DATABASE", "file=backup-belgindo-inventory.json", "app_meta", null);
    const stamp = todayISO().replace(/-/g, "");
    return {
      __download__: {
        filename: `backup-belgindo-inventory-${stamp}.json`,
        content: JSON.stringify(payload, null, 2),
        mime: "application/json",
      },
    };
  }

  /* ------------------------------------------------------------ dispatch */

  async function dispatch({ method, path, query = {}, body = null, token = null, ip = "" }) {
    await engine.ensureReady();
    await ensureSeeded();
    method = String(method).toUpperCase();
    let cleanPath = String(path || "").split("?")[0];
    try {
      cleanPath = decodeURIComponent(cleanPath);
    } catch {
      /* jalur sudah terbaca */
    }
    if (cleanPath.length > 1) cleanPath = cleanPath.replace(/\/+$/, "");
    const candidate = routes.find((item) => item.method === method && item.pattern.test(cleanPath));
    if (!candidate) throw new AppError("Endpoint tidak ditemukan.", 404, "NOT_FOUND");
    const match = candidate.pattern.exec(cleanPath);
    let user = null;
    if (candidate.authRequired !== false) {
      user = currentUserOf(engine, token);
      if (!user) throw new AuthError("Sesi tidak ditemukan atau sudah berakhir. Silakan login kembali.");
    }
    const result = await engine.run(async (ctx) => {
      const d = makeHandle(engine, ctx);
      return candidate.handler(d, { query, body, user, token, ip }, match);
    });
    if (result && typeof result === "object" && "__token" in result) {
      const { __token, __login_user_id, ...rest } = result;
      /* Catatan last_login/log bersifat tambahan: kegagalan menulisnya
         (mis. koneksi putus sesaat) tidak boleh menggagalkan login. */
      if (__login_user_id) {
        try {
          await engine.run(async (ctx) => {
            const d = makeHandle(engine, ctx);
            d.update("users", __login_user_id, { last_login: d.now });
            log2(d, __login_user_id, "LOGIN", `user=${rest.user?.username || ""}`, "users", __login_user_id);
          });
        } catch { /* abaikan */ }
      }
      return { token: __token, data: rest };
    }
    return { data: result };
  }

  return { dispatch, sessions, appInfo, permissionsFor };
}

function round4(value) {
  return pyRoundLocal(value, 4);
}
function round6(value) {
  return pyRoundLocal(value, 6);
}
function pyRoundLocal(value, digits) {
  const num = Number(value);
  const factor = 10 ** digits;
  return Math.round((num + Number.EPSILON) * factor) / factor;
}
