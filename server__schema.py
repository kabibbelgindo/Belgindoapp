"""Skema database SQLite untuk aplikasi inventori PT. BELGINDO RAYA."""

SCHEMA_VERSION = 1

DDL = r"""
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    full_name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    is_primary_admin INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login TEXT
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL COLLATE NOCASE,
    unit TEXT NOT NULL DEFAULT 'batang',
    purchase_price REAL NOT NULL DEFAULT 0,
    spec_t REAL,
    spec_l REAL,
    spec_p REAL,
    min_stock REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_active_prices (
    product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    active_price REAL NOT NULL DEFAULT 0,
    updated_at TEXT,
    updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS master_spec_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dimension TEXT NOT NULL CHECK (dimension IN ('T', 'L', 'P')),
    value REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (dimension, value)
);

CREATE TABLE IF NOT EXISTS master_price_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    price REAL NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    city TEXT,
    phone TEXT,
    address TEXT,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seller_rits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL REFERENCES sellers(id),
    rit_number INTEGER NOT NULL,
    rit_date TEXT NOT NULL,
    rit_month TEXT NOT NULL,
    delivery_number TEXT NOT NULL,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE (seller_id, rit_month, rit_number)
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trx_date TEXT NOT NULL,
    trx_type TEXT NOT NULL CHECK (trx_type IN ('MASUK', 'KELUAR')),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty REAL NOT NULL CHECK (qty > 0),
    price REAL NOT NULL DEFAULT 0,
    note TEXT,
    trx_size TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    seller_id INTEGER REFERENCES sellers(id),
    rit_id INTEGER REFERENCES seller_rits(id),
    source_trx_id INTEGER,
    trx_number TEXT,
    delivery_number TEXT,
    supplier TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trx_date ON transactions(trx_date);
CREATE INDEX IF NOT EXISTS idx_trx_product_size ON transactions(product_id, trx_size);
CREATE INDEX IF NOT EXISTS idx_trx_source ON transactions(source_trx_id);
CREATE INDEX IF NOT EXISTS idx_trx_number ON transactions(trx_number);
CREATE INDEX IF NOT EXISTS idx_trx_rit ON transactions(rit_id);

CREATE TABLE IF NOT EXISTS location_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_date TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    trx_size TEXT NOT NULL,
    from_location TEXT NOT NULL,
    to_location TEXT NOT NULL,
    qty REAL NOT NULL CHECK (qty > 0),
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfer_date ON location_transfers(transfer_date);
CREATE INDEX IF NOT EXISTS idx_transfer_product ON location_transfers(product_id, trx_size);

CREATE TABLE IF NOT EXISTS tally_headers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tally_number TEXT NOT NULL UNIQUE,
    rit_id INTEGER REFERENCES seller_rits(id),
    seller_id INTEGER REFERENCES sellers(id),
    note TEXT,
    delivery_number TEXT,
    status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'BATAL')),
    signature TEXT NOT NULL,
    total_qty REAL NOT NULL DEFAULT 0,
    total_volume REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    cancel_note TEXT
);

CREATE TABLE IF NOT EXISTS tally_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tally_id INTEGER NOT NULL REFERENCES tally_headers(id) ON DELETE CASCADE,
    trx_id INTEGER NOT NULL REFERENCES transactions(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    trx_size TEXT NOT NULL,
    qty REAL NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('FRESH', 'AFKIR')),
    price_m3 REAL NOT NULL DEFAULT 0,
    volume REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_tally_items_trx ON tally_items(trx_id);
CREATE INDEX IF NOT EXISTS idx_tally_header_rit ON tally_headers(rit_id, note);

CREATE TABLE IF NOT EXISTS payment_recap_headers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recap_number TEXT NOT NULL UNIQUE,
    seller_id INTEGER REFERENCES sellers(id),
    rit_id INTEGER REFERENCES seller_rits(id),
    note TEXT,
    total_qty REAL NOT NULL DEFAULT 0,
    total_volume REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF', 'BATAL')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    cancel_note TEXT
);

CREATE TABLE IF NOT EXISTS payment_recap_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recap_id INTEGER NOT NULL REFERENCES payment_recap_headers(id) ON DELETE CASCADE,
    trx_id INTEGER NOT NULL REFERENCES transactions(id),
    active INTEGER NOT NULL DEFAULT 1,
    qty REAL NOT NULL,
    trx_size TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    volume REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_recap_trx
    ON payment_recap_items(trx_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_recap_header_rit ON payment_recap_headers(rit_id, note);

CREATE TABLE IF NOT EXISTS stock_opname (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    period_year INTEGER NOT NULL,
    period_month INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DONE')),
    user_id INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (period_start, period_end)
);

CREATE TABLE IF NOT EXISTS stock_opname_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opname_id INTEGER NOT NULL REFERENCES stock_opname(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    trx_size TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    system_qty REAL NOT NULL DEFAULT 0,
    physical_qty REAL,
    reason TEXT,
    note TEXT,
    UNIQUE (opname_id, product_id, trx_size, location)
);

CREATE TABLE IF NOT EXISTS stock_period_closures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opname_id INTEGER NOT NULL UNIQUE REFERENCES stock_opname(id),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    item_count INTEGER NOT NULL DEFAULT 0,
    note TEXT
);

CREATE TABLE IF NOT EXISTS stock_period_closure_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    closure_id INTEGER NOT NULL REFERENCES stock_period_closures(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL,
    trx_size TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    closing_qty REAL NOT NULL,
    opening_qty REAL NOT NULL,
    in_qty REAL NOT NULL,
    out_qty REAL NOT NULL,
    transfer_qty REAL NOT NULL,
    adj_qty REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_closure_items ON stock_period_closure_items(closure_id);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_time TEXT NOT NULL,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(event_time);

CREATE TABLE IF NOT EXISTS sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SYNCED',
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_created ON sync_outbox(created_at);
"""
