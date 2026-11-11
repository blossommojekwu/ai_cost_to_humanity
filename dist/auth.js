import crypto from 'crypto';
import { promisify } from 'util';
// ---------------------------------------------------------------------------
// Passwords: salted scrypt (Node built-in, memory-hard). Never stored in plain text.
// ---------------------------------------------------------------------------
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, 64, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
export async function verifyPassword(password, stored) {
    const [alg, N, r, p, saltB64, keyB64] = stored.split('$');
    if (alg !== 'scrypt' || !saltB64 || !keyB64)
        return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(N),
        r: Number(r),
        p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
// Verified against when the username doesn't exist, so timing doesn't reveal which usernames are taken.
let dummyHash = null;
const getDummyHash = () => (dummyHash ?? (dummyHash = hashPassword('not-a-real-password')));
// ---------------------------------------------------------------------------
// Cookie tokens (random; only a SHA-256 of the token is stored)
// ---------------------------------------------------------------------------
const COOKIE = 'pb_token';
const USER_TTL_MS = 7 * 24 * 3600 * 1000;
const GUEST_TTL_MS = 12 * 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
function parseCookies(header) {
    const out = {};
    for (const part of (header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0)
            out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}
function setCookie(res, token, maxAgeMs) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
}
function clearCookie(res) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
/** The login (registered or guest) behind this request's cookie, if any. */
export function currentLogin(req, store) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? store.getLogin(sha256(token)) : undefined;
}
// ---------------------------------------------------------------------------
// Tiny in-memory rate limiter
// ---------------------------------------------------------------------------
const hits = new Map();
function tooMany(key, max, windowMs) {
    const t = Date.now();
    const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    return arr.length > max;
}
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerAccountRoutes(app, store) {
    setInterval(() => store.purgeExpired(), 3600 * 1000).unref();
    /** What the page needs to rebuild itself: who, the open session, held irreversibles. */
    function me(login) {
        const user = login.user_id != null ? store.getUserById(login.user_id) : undefined;
        const open = store.getOpenSession(login);
        return {
            authenticated: true,
            guest: login.user_id == null,
            username: user?.username ?? null,
            irreversible: login.user_id != null ? store.getIrreversible(login.user_id) : [],
            session: open ? store.sessionDetail(open.id) : null,
            lifetime: login.user_id != null ? store.lifetime(login.user_id) : null,
        };
    }
    function startLogin(res, userId) {
        const token = newToken();
        const ttl = userId == null ? GUEST_TTL_MS : USER_TTL_MS;
        const login = store.createLogin(sha256(token), userId, new Date(Date.now() + ttl).toISOString());
        setCookie(res, token, ttl);
        return login;
    }
    const creds = (req) => {
        const b = req.body ?? {};
        return {
            username: typeof b.username === 'string' ? b.username.trim() : '',
            password: typeof b.password === 'string' ? b.password : '',
        };
    };
    app.post('/api/auth/register', async (req, res) => {
        try {
            if (tooMany(`reg|${req.ip}`, 10, 3600000)) {
                return res.status(429).json({ error: 'Too many sign-ups from here. Try again later.' });
            }
            const { username, password } = creds(req);
            if (!USERNAME_RE.test(username)) {
                return res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, . _ -' });
            }
            if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
                return res.status(400).json({ error: `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters.` });
            }
            const user = store.createUser(username, await hashPassword(password));
            if (!user)
                return res.status(409).json({ error: 'That username is already taken.' });
            res.status(201).json(me(startLogin(res, user.id)));
        }
        catch (err) {
            console.error('register error:', err);
            res.status(500).json({ error: 'Could not create the account.' });
        }
    });
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { username, password } = creds(req);
            const key = `login|${req.ip}|${username.toLowerCase()}`;
            if (tooMany(key, 10, 15 * 60000)) {
                return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
            }
            if (!username || !password || password.length > MAX_PASSWORD) {
                return res.status(400).json({ error: 'Enter your username and password.' });
            }
            const user = store.getUserByUsername(username);
            const ok = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
            if (!user || !ok)
                return res.status(401).json({ error: 'Invalid username or password.' });
            hits.delete(key);
            res.json(me(startLogin(res, user.id)));
        }
        catch (err) {
            console.error('login error:', err);
            res.status(500).json({ error: 'Could not log in.' });
        }
    });
    app.post('/api/auth/guest', (_req, res) => {
        res.json(me(startLogin(res, null)));
    });
    app.post('/api/auth/logout', (req, res) => {
        const login = currentLogin(req, store);
        if (login)
            store.logout(login); // ends the session; guest data is deleted
        clearCookie(res);
        res.json({ ok: true });
    });
    app.get('/api/auth/me', (req, res) => {
        const login = currentLogin(req, store);
        if (!login)
            return res.json({ authenticated: false });
        res.json(me(login));
    });
    // "Close session": ends it. Guest data is deleted; users keep irreversible incidents.
    app.post('/api/session/close', (req, res) => {
        const login = currentLogin(req, store);
        if (!login)
            return res.status(401).json({ error: 'Not signed in.' });
        store.endSession(login);
        res.json({ ok: true, irreversible: login.user_id != null ? store.getIrreversible(login.user_id) : [] });
    });
    // Delete history. Irreversible incidents stay.
    app.delete('/api/history', (req, res) => {
        const login = currentLogin(req, store);
        if (!login)
            return res.status(401).json({ error: 'Not signed in.' });
        store.deleteHistory(login);
        res.json({ ok: true, irreversible: login.user_id != null ? store.getIrreversible(login.user_id) : [] });
    });
}
//# sourceMappingURL=auth.js.map