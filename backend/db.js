const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL) {
  // ── PostgreSQL mode (Render production) ─────────────────────────────────────
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const initSQL = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      balance REAL DEFAULT 100000000,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS portfolios (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      asset_symbol TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      quantity REAL NOT NULL,
      average_price REAL NOT NULL,
      asset_name TEXT,
      UNIQUE(user_id, asset_symbol)
    );
    ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS asset_name TEXT;
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      asset_symbol TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      total_amount REAL NOT NULL,
      fee REAL DEFAULT 0,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS balance_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      total_asset_krw REAL NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    UPDATE portfolios SET asset_symbol = 'POLUSDT' WHERE asset_symbol IN ('MATICUSDT', 'MATIC-USD');
    UPDATE transactions SET asset_symbol = 'POLUSDT' WHERE asset_symbol IN ('MATICUSDT', 'MATIC-USD');
  `;

  pool.query(initSQL)
    .then(() => console.log('✅ Connected to PostgreSQL and tables initialized.'))
    .catch(err => console.error('❌ PostgreSQL init error:', err.message));

  // Convert SQLite ? placeholders → PostgreSQL $1, $2 ...
  function toPostgres(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  module.exports = {
    _type: 'pg',
    _pool: pool,

    run(sql, params, callback) {
      pool.query(toPostgres(sql), params || [])
        .then(result => {
          if (callback) callback.call({ lastID: result.rows[0]?.id, changes: result.rowCount }, null);
        })
        .catch(err => {
          if (callback) callback.call({}, err);
          else console.error('db.run error:', err.message);
        });
    },

    get(sql, params, callback) {
      pool.query(toPostgres(sql), params || [])
        .then(result => callback(null, result.rows[0] || null))
        .catch(err => callback(err, null));
    },

    all(sql, params, callback) {
      pool.query(toPostgres(sql), params || [])
        .then(result => callback(null, result.rows))
        .catch(err => callback(err, null));
    },

    serialize(fn) { fn(); },

    // Transaction helper — returns a client with .get, .run, .commit, .rollback
    async beginTransaction() {
      const client = await pool.connect();
      await client.query('BEGIN');
      return {
        get: (sql, params) => client.query(toPostgres(sql), params || []).then(r => r.rows[0] || null),
        run: (sql, params) => client.query(toPostgres(sql), params || []).then(r => ({ rowCount: r.rowCount, rows: r.rows })),
        commit: () => client.query('COMMIT').finally(() => client.release()),
        rollback: () => client.query('ROLLBACK').finally(() => client.release()),
      };
    }
  };

} else {
  // ── SQLite mode (local development) ──────────────────────────────────────────
  const sqlite3 = require('sqlite3').verbose();
  const path = require('path');

  const dbPath = path.resolve(__dirname, 'paper_trading.sqlite');
  const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening database:', err.message);
    } else {
      console.log('Connected to the SQLite database.');
      db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          nickname TEXT NOT NULL,
          password TEXT NOT NULL,
          balance REAL DEFAULT 100000000,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS portfolios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          asset_symbol TEXT NOT NULL,
          asset_type TEXT NOT NULL,
          quantity REAL NOT NULL,
          average_price REAL NOT NULL,
          asset_name TEXT,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(user_id, asset_symbol)
        )`);
        // 기존 DB에 asset_name 컬럼이 없으면 추가 (SQLite는 IF NOT EXISTS 미지원 → 에러는 무시)
        db.run(`ALTER TABLE portfolios ADD COLUMN asset_name TEXT`, [], () => {});
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          asset_symbol TEXT NOT NULL,
          asset_type TEXT NOT NULL,
          type TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL NOT NULL,
          total_amount REAL NOT NULL,
          fee REAL DEFAULT 0,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS balance_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          total_asset_krw REAL NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )`);
        db.run(`UPDATE portfolios SET asset_symbol = 'POLUSDT' WHERE asset_symbol IN ('MATICUSDT', 'MATIC-USD')`);
        db.run(`UPDATE transactions SET asset_symbol = 'POLUSDT' WHERE asset_symbol IN ('MATICUSDT', 'MATIC-USD')`);
      });
    }
  });

  db._type = 'sqlite';

  // SQLite transaction helper (same interface as PG version)
  db.beginTransaction = () => {
    return new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', [], (err) => {
        if (err) return reject(err);
        resolve({
          get: (sql, params) => new Promise((res, rej) =>
            db.get(sql, params, (err, row) => err ? rej(err) : res(row))),
          run: (sql, params) => new Promise((res, rej) =>
            db.run(sql, params, function(err) { err ? rej(err) : res({ rowCount: this.changes, rows: [] }); })),
          commit: () => new Promise((res, rej) =>
            db.run('COMMIT', [], (err) => err ? rej(err) : res())),
          rollback: () => new Promise((res, rej) =>
            db.run('ROLLBACK', [], (err) => err ? rej(err) : res())),
        });
      });
    });
  };

  module.exports = db;
}
