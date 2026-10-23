// Cloudflare Pages Functions: /api/auth/register, login, me and logout.
const SESSION_SECONDS = 12 * 60 * 60;
const ITERATIONS = 100000; // Supported by Cloudflare's Web Crypto runtime.
const encoder = new TextEncoder();
const initialized = new WeakMap();

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra
  } });
}
function database(env) {
  const db = env.DB || env.USER_DB || env['user-db'];
  if (!db?.prepare) throw new ApiError(503, '账号服务尚未配置数据库绑定，请联系站点管理员。');
  return db;
}
async function initialize(db) {
  if (!initialized.has(db)) {
    const pending = db.batch([
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_users_username_ci ON users(username COLLATE NOCASE)'),
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_users_email_ci ON users(email COLLATE NOCASE)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_atlas_sessions_expires_at ON sessions(expires_at)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_atlas_rate_expires_at ON auth_rate_limits(expires_at)')
    ]).catch(err => { initialized.delete(db); throw err; });
    initialized.set(db, pending);
  }
  await initialized.get(db);
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = str => Uint8Array.from(str.match(/../g) || [], b => parseInt(b, 16));
async function sha256(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
async function derive(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt, iterations}, key, 256)));
}
async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$${ITERATIONS}$${hex(salt)}$${await derive(password, salt)}`;
}
async function verifyPassword(password, encoded) {
  const [algorithm, count, salt, expected] = String(encoded).split('$');
  if (algorithm !== 'pbkdf2_sha256' || !/^\d+$/.test(count) || +count < 1 || +count > ITERATIONS ||
      !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
  const actual = await derive(password, unhex(salt), +count);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
function cookieName(request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-atlas_session' : 'atlas_session';
}
function sessionCookie(request, token, maxAge = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function readToken(request) {
  const prefix = `${cookieName(request)}=`;
  const pair = (request.headers.get('Cookie') || '').split(';').map(c => c.trim()).find(c => c.startsWith(prefix));
  const token = pair?.slice(prefix.length);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}
function publicUser(row) {
  return {id:row.id, account:row.username, name:row.nickname || row.username};
}
async function newSession() {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  return {token, hash:await sha256(token), expires:Math.floor(Date.now()/1000) + SESSION_SECONDS};
}
function sessionStatement(db, userId, session) {
  return db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(session.hash, userId, session.expires);
}
function cleanup(context, db) {
  if (context.waitUntil) context.waitUntil(db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Math.floor(Date.now()/1000)),
    db.prepare('DELETE FROM auth_rate_limits WHERE expires_at <= ?').bind(Math.floor(Date.now()/1000))
  ]).catch(() => {}));
}
async function checkRate(db, request, action) {
  const now = Math.floor(Date.now()/1000);
  const window = Math.floor(now/600);
  // CF-Connecting-IP is populated by Cloudflare. Local clients share a test bucket.
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = await sha256(`${action}:${ip}:${window}`);
  const result = await db.prepare(`INSERT INTO auth_rate_limits (key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(key, (window+1)*600).first();
  const limit = action === 'register' ? 5 : 30;
  if (result.attempts > limit) throw new ApiError(429, '操作太频繁，请稍后再试。');
}
async function bodyJson(request) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json'))
    throw new ApiError(415, '请求必须使用 JSON 格式。');
  if (+request.headers.get('Content-Length') > 8192) throw new ApiError(413, '请求内容过长。');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, '请求内容不能为空。');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new ApiError(413, '请求内容过长。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new ApiError(400, '请求内容不是有效的 JSON 对象。'); }
}
function credentials(body) {
  const username = typeof body.account === 'string' ? body.account.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new ApiError(400, '用户名须为 3–32 位字母、数字或下划线。');
  if (password.length < 8 || password.length > 128) throw new ApiError(400, '密码长度须为 8–128 位。');
  return {username, password};
}
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')
    throw new ApiError(403, '请从本站页面发起操作。');
}

export async function onRequest(context) {
  const {request, env} = context;
  const action = new URL(request.url).pathname.replace(/\/$/, '').split('/').pop();
  const methods = {register:'POST', login:'POST', logout:'POST', me:'GET'};
  if (!methods[action]) return json({error:'接口不存在。'}, 404);
  if (request.method !== methods[action]) return json({error:'不支持的请求方法。'}, 405, {Allow:methods[action]});
  try {
    if (request.method === 'POST') sameOrigin(request);
    const db = database(env);
    await initialize(db);
    if (action === 'me') {
      const token = readToken(request);
      const row = token && await db.prepare(`SELECT users.id, users.username, users.nickname FROM sessions
        JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?`)
        .bind(await sha256(token), Math.floor(Date.now()/1000)).first();
      // Read-only checks must not clear a newer cookie set by a concurrent login.
      return json({user:row ? publicUser(row) : null});
    }
    if (action === 'logout') {
      const token = readToken(request);
      if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
      return json({ok:true}, 200, {'Set-Cookie':sessionCookie(request, '', 0)});
    }
    const body = await bodyJson(request);
    const {username, password} = credentials(body);
    await checkRate(db, request, action);
    let user;
    if (action === 'register') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const nickname = typeof body.name === 'string' ? body.name.trim() : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, '请输入有效的邮箱地址。');
      if (nickname.length < 2 || nickname.length > 20) throw new ApiError(400, '昵称长度须为 2–20 个字符。');
      const encoded = await passwordHash(password);
      const session = await newSession();
      // D1 batch executes atomically: a failed session insert rolls back account creation.
      try {
        await db.batch([
          db.prepare('INSERT INTO users (username, email, password_hash, nickname) VALUES (?, ?, ?, ?)')
            .bind(username, email, encoded, nickname),
          db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at)
            SELECT ?, id, ? FROM users WHERE username = ? COLLATE NOCASE`).bind(session.hash, session.expires, username)
        ]);
      } catch (err) {
        if (/UNIQUE constraint failed/i.test(String(err?.message))) throw new ApiError(409, '用户名或邮箱已注册，请登录或更换后重试。');
        throw err;
      }
      user = await db.prepare('SELECT id, username, nickname FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
      cleanup(context, db);
      return json({user:publicUser(user)}, 201, {'Set-Cookie':sessionCookie(request, session.token)});
    }
    user = await db.prepare('SELECT id, username, nickname, password_hash FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
    const dummy = `pbkdf2_sha256$${ITERATIONS}$${'0'.repeat(32)}$${'0'.repeat(64)}`;
    const valid = await verifyPassword(password, user?.password_hash || dummy);
    if (!user || !valid) throw new ApiError(401, '用户名或密码不正确，请重试。');
    const session = await newSession();
    const previous = readToken(request);
    const writes = [sessionStatement(db, user.id, session)];
    if (previous) writes.push(db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(previous)));
    await db.batch(writes);
    cleanup(context, db);
    return json({user:publicUser(user)}, 200, {'Set-Cookie':sessionCookie(request, session.token)});
  } catch (err) {
    if (!(err instanceof ApiError)) console.error('Auth database/runtime failure:', err?.message);
    return json({error:err instanceof ApiError ? err.message : '账号服务暂时不可用，请稍后重试。'}, err instanceof ApiError ? err.status : 503,
      err?.status === 429 ? {'Retry-After':'600'} : {});
  }
}
