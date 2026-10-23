import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequest} from '../functions/api/auth/[[path]].js';

// Execute actual SQL against SQLite behind a D1-compatible interface.
function fixture(binding = 'DB') {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON;');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const wrap = (query, values = []) => ({
    bind(...next) { return wrap(query, next); },
    async first() { return sql.prepare(query).get(...values) || null; },
    async run() { return {meta:sql.prepare(query).run(...values)}; },
    execute() { return sql.prepare(query).run(...values); }
  });
  const db = {prepare:wrap, async batch(statements) {
    sql.exec('BEGIN');
    try { const result = statements.map(s => s.execute()); sql.exec('COMMIT'); return result; }
    catch (err) { sql.exec('ROLLBACK'); throw err; }
  }};
  const pending = [];
  async function call(action, {body, cookie, method, origin = 'https://atlas.example', raw, type = 'application/json'} = {}) {
    const verb = method || (action === 'me' ? 'GET' : 'POST');
    const headers = {'CF-Connecting-IP':'192.0.2.1'};
    if (origin !== null) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (verb === 'POST') headers['Content-Type'] = type;
    const request = new Request(`https://atlas.example/api/auth/${action}`, {method:verb, headers,
      body:verb === 'POST' ? (raw ?? JSON.stringify(body ?? {})) : undefined});
    const response = await onRequest({request, env:{[binding]:db}, waitUntil:p => pending.push(p)});
    await Promise.all(pending.splice(0));
    return {response, data:await response.json(), cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  return {sql, call};
}
const account = {account:'Example_User', password:'UniqueDemoPassword_1023', name:'测试用户', email:'example@example.com'};

test('register, authenticate, rotate, expire and revoke a session', async () => {
  const {sql, call} = fixture();
  const first = await call('register', {body:account});
  assert.equal(first.response.status, 201);
  assert.equal(first.data.user.account, 'example_user');
  assert.equal(first.data.user.name, account.name);
  assert.match(first.response.headers.get('Set-Cookie'), /__Host-atlas_session=.*HttpOnly; SameSite=Lax.*Secure/);
  assert.equal(first.response.headers.get('Cache-Control'), 'no-store');
  assert.match(sql.prepare('SELECT password_hash FROM users').get().password_hash, /^pbkdf2_sha256\$100000\$/);
  assert.notEqual(sql.prepare('SELECT token_hash FROM sessions').get().token_hash, first.cookie.split('=')[1]);
  assert.equal((await call('me', {cookie:first.cookie})).data.user.name, account.name);
  assert.equal((await call('me')).data.user, null);
  assert.equal((await call('me')).response.headers.get('Set-Cookie'), null);
  assert.equal((await call('login', {body:{...account, password:'WrongPassword'}})).response.status, 401);
  assert.equal((await call('login', {body:{...account, account:'unknown_user'}})).response.status, 401);
  const login = await call('login', {body:account, cookie:first.cookie});
  assert.equal(login.response.status, 200);
  assert.notEqual(login.cookie, first.cookie);
  assert.equal((await call('me', {cookie:first.cookie})).data.user, null);
  assert.ok((await call('me', {cookie:login.cookie})).data.user);
  assert.match((await call('logout', {cookie:login.cookie})).response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await call('me', {cookie:login.cookie})).data.user, null);
  const second = await call('login', {body:account});
  sql.prepare('UPDATE sessions SET expires_at = 0').run();
  assert.equal((await call('me', {cookie:second.cookie})).data.user, null);
  sql.close();
});

test('unique usernames/emails, parameterized SQL and input validation', async () => {
  const {sql, call} = fixture('user-db');
  assert.equal((await call('register', {body:account})).response.status, 201);
  assert.equal((await call('register', {body:{...account, email:'other@example.com'}})).response.status, 409);
  assert.equal((await call('register', {body:{...account, account:'another', email:'EXAMPLE@EXAMPLE.COM'}})).response.status, 409);
  for (const changes of [{account:"user' OR 1=1--"}, {email:''}, {password:'short'}, {name:' '}])
    assert.equal((await call('register', {body:{...account, ...changes}})).response.status, 400);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  sql.close();
});

test('CSRF, methods, malformed JSON, size limit and missing bindings', async () => {
  const {sql, call} = fixture();
  for (const origin of ['https://attacker.example', null, 'null'])
    assert.equal((await call('register', {body:account, origin})).response.status, 403);
  assert.equal((await call('register', {method:'GET'})).response.status, 405);
  assert.equal((await call('unknown')).response.status, 404);
  assert.equal((await call('register', {raw:'{'})).response.status, 400);
  assert.equal((await call('register', {raw:'[]'})).response.status, 400);
  assert.equal((await call('register', {type:'text/plain', body:account})).response.status, 415);
  assert.equal((await call('register', {raw:'x'.repeat(9000)})).response.status, 413);
  const missing = await onRequest({request:new Request('https://atlas.example/api/auth/me'), env:{}});
  assert.equal(missing.status, 503);
  sql.close();
});

test('registration limits use atomic D1 counters', async () => {
  const {sql, call} = fixture('USER_DB');
  for (let i = 0; i < 5; i++)
    assert.equal((await call('register', {body:{...account, account:`user_${i}`, email:`user${i}@example.com`}})).response.status, 201);
  const blocked = await call('register', {body:{...account, account:'user_6', email:'user6@example.com'}});
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.response.headers.get('Retry-After'), '600');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM users').get().n, 5);
  sql.close();
});

test('session insert failure rolls back account creation', async () => {
  const {sql, call} = fixture();
  sql.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.equal((await call('register', {body:account})).response.status, 503);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  sql.close();
});
