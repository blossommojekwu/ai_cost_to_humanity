import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logins (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  prompt_count    INTEGER NOT NULL DEFAULT 0,
  total_energy_wh REAL NOT NULL DEFAULT 0,
  total_water_ml  REAL NOT NULL DEFAULT 0,
  total_carbon_g  REAL NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_user
  ON sessions(user_id) WHERE ended_at IS NULL AND user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  model_label TEXT,
  size_bucket TEXT,
  energy_wh   REAL,
  water_ml    REAL,
  carbon_g    REAL,
  match_count INTEGER NOT NULL DEFAULT 0,
  env_json    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prompts_by_session ON prompts(session_id);

CREATE TABLE IF NOT EXISTS prompt_incidents (
  prompt_id   INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  incident_id INTEGER NOT NULL,
  similarity  REAL NOT NULL,
  PRIMARY KEY (prompt_id, incident_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS user_irreversible (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  incident_id INTEGER NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, incident_id)
) WITHOUT ROWID;
`;
const now = () => new Date().toISOString();
export class Store {
    constructor(file) {
        this.stmts = new Map();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(SCHEMA);
        this.purgeOnStart();
    }
    s(sql) {
        let st = this.stmts.get(sql);
        if (!st) {
            st = this.db.prepare(sql);
            this.stmts.set(sql, st);
        }
        return st;
    }
    // ------------------------------------------------------------------ users
    createUser(username, passwordHash) {
        try {
            const info = this.s('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(username, passwordHash, now());
            return { id: Number(info.lastInsertRowid), username, password_hash: passwordHash };
        }
        catch (e) {
            if (String(e?.code).startsWith('SQLITE_CONSTRAINT'))
                return null; // username taken
            throw e;
        }
    }
    getUserByUsername(username) {
        return this.s('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
    }
    getUserById(id) {
        return this.s('SELECT id, username FROM users WHERE id = ?').get(id);
    }
    // ----------------------------------------------------------------- logins
    createLogin(tokenHash, userId, expiresAt) {
        this.s('INSERT INTO logins (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, now(), expiresAt);
        return { token_hash: tokenHash, user_id: userId, expires_at: expiresAt };
    }
    /** The login for a token hash, or undefined if unknown/expired. */
    getLogin(tokenHash) {
        const row = this.s('SELECT token_hash, user_id, expires_at FROM logins WHERE token_hash = ?').get(tokenHash);
        if (!row)
            return undefined;
        if (row.expires_at < now()) {
            this.purgeExpired();
            return undefined;
        }
        return row;
    }
    /** Logout: end the session (guests: delete their data) and drop the login. */
    logout(login) {
        this.db.transaction(() => {
            this.endSession(login);
            this.s('DELETE FROM logins WHERE token_hash = ?').run(login.token_hash);
        })();
    }
    // --------------------------------------------------------------- sessions
    openSessionRow(login) {
        return login.user_id != null
            ? this.s('SELECT * FROM sessions WHERE user_id = ? AND ended_at IS NULL').get(login.user_id)
            : this.s('SELECT * FROM sessions WHERE user_id IS NULL AND token_hash = ? AND ended_at IS NULL').get(login.token_hash);
    }
    summary(r) {
        return {
            id: r.id,
            promptCount: r.prompt_count,
            totalEnergyWh: r.total_energy_wh,
            totalWaterMl: r.total_water_ml,
            totalCarbonG: r.total_carbon_g,
        };
    }
    getOpenSession(login) {
        const r = this.openSessionRow(login);
        return r ? this.summary(r) : undefined;
    }
    /** The open session, starting one on first use. */
    ensureSession(login) {
        const r = this.openSessionRow(login);
        if (r)
            return this.summary(r);
        const info = this.s('INSERT INTO sessions (user_id, token_hash, started_at) VALUES (?, ?, ?)').run(login.user_id, login.user_id == null ? login.token_hash : null, now());
        return this.summary(this.s('SELECT * FROM sessions WHERE id = ?').get(Number(info.lastInsertRowid)));
    }
    sessionSummary(id) {
        return this.summary(this.s('SELECT * FROM sessions WHERE id = ?').get(id));
    }
    /** Session end. Registered users keep the record; guests' data is deleted. */
    endSession(login) {
        if (login.user_id != null) {
            this.s('UPDATE sessions SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL').run(now(), login.user_id);
        }
        else {
            this.s('DELETE FROM sessions WHERE user_id IS NULL AND token_hash = ?').run(login.token_hash);
        }
    }
    /** Delete all prompt history. Irreversible incidents are NOT touched. */
    deleteHistory(login) {
        if (login.user_id != null) {
            this.s('DELETE FROM sessions WHERE user_id = ?').run(login.user_id);
        }
        else {
            this.s('DELETE FROM sessions WHERE user_id IS NULL AND token_hash = ?').run(login.token_hash);
        }
    }
    /** Record a prompt, its matches, and the running totals in one transaction. */
    recordPrompt(sessionId, p, matches) {
        this.db.transaction(() => {
            const info = this.s(`INSERT INTO prompts (session_id, text, model_id, model_label, size_bucket,
                              energy_wh, water_ml, carbon_g, match_count, env_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, p.text, p.modelId, p.modelLabel, p.size, p.energyWh, p.waterMl, p.carbonG, matches.length, p.envJson, now());
            const promptId = Number(info.lastInsertRowid);
            const ins = this.s('INSERT OR IGNORE INTO prompt_incidents (prompt_id, incident_id, similarity) VALUES (?, ?, ?)');
            for (const m of matches)
                ins.run(promptId, m.id, m.similarity);
            // A blank CSV cell is NULL: it adds nothing to the total.
            this.s(`UPDATE sessions SET prompt_count = prompt_count + 1,
           total_energy_wh = total_energy_wh + COALESCE(?, 0),
           total_water_ml  = total_water_ml  + COALESCE(?, 0),
           total_carbon_g  = total_carbon_g  + COALESCE(?, 0)
         WHERE id = ?`).run(p.energyWh, p.waterMl, p.carbonG, sessionId);
        })();
        return this.sessionSummary(sessionId);
    }
    /** Everything needed to rebuild the page after a reload. */
    sessionDetail(sessionId) {
        const sum = this.sessionSummary(sessionId);
        const rows = this.s('SELECT id, text, model_id, created_at, env_json FROM prompts WHERE session_id = ? ORDER BY id').all(sessionId);
        const surfaced = this.s(`SELECT DISTINCT pi.incident_id AS id FROM prompt_incidents pi
           JOIN prompts p ON p.id = pi.prompt_id WHERE p.session_id = ?`).all(sessionId).map((r) => r.id);
        let last = null;
        if (rows.length) {
            const l = rows[rows.length - 1];
            const matched = this.s('SELECT incident_id AS id FROM prompt_incidents WHERE prompt_id = ? ORDER BY similarity DESC').all(l.id).map((r) => r.id);
            let environmental = null;
            try {
                environmental = l.env_json ? JSON.parse(l.env_json) : null;
            }
            catch {
                /* ignore */
            }
            last = { text: l.text, matched, environmental };
        }
        return {
            ...sum,
            prompts: rows.map((r) => ({ id: r.id, text: r.text, modelId: r.model_id, createdAt: r.created_at })),
            surfaced,
            last,
        };
    }
    lifetime(userId) {
        const r = this.s(`SELECT COUNT(*) AS sessions, COALESCE(SUM(prompt_count),0) AS prompts,
              COALESCE(SUM(total_energy_wh),0) AS e, COALESCE(SUM(total_water_ml),0) AS w,
              COALESCE(SUM(total_carbon_g),0) AS c
         FROM sessions WHERE user_id = ?`).get(userId);
        return { sessions: r.sessions, prompts: r.prompts, energyWh: r.e, waterMl: r.w, carbonG: r.c };
    }
    // ------------------------------------------------------- irreversible set
    /** Persist irreversible incidents for a user. Returns the ones that were new. */
    addIrreversible(userId, ids) {
        const added = [];
        this.db.transaction(() => {
            const ins = this.s('INSERT OR IGNORE INTO user_irreversible (user_id, incident_id, added_at) VALUES (?, ?, ?)');
            for (const id of ids)
                if (ins.run(userId, id, now()).changes)
                    added.push(id);
        })();
        return added;
    }
    getIrreversible(userId) {
        return this.s('SELECT incident_id AS id FROM user_irreversible WHERE user_id = ? ORDER BY added_at').all(userId).map((r) => r.id);
    }
    // ---------------------------------------------------------------- cleanup
    purgeExpired() {
        this.s('DELETE FROM logins WHERE expires_at < ?').run(now());
        // guest sessions whose login is gone
        this.s('DELETE FROM sessions WHERE user_id IS NULL AND (token_hash IS NULL OR token_hash NOT IN (SELECT token_hash FROM logins))').run();
    }
    /** Guest data does not outlive the server process. */
    purgeOnStart() {
        this.s('DELETE FROM logins WHERE user_id IS NULL').run();
        this.purgeExpired();
    }
}
//# sourceMappingURL=db.js.map