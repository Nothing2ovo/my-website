// Same-origin Pages Functions API. Session tokens are only held in HttpOnly cookies.
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const modal = $('#auth-dialog');
  const form = $('#auth-form');
  const error = $('#auth-error');
  const submit = $('#auth-submit');
  let mode = 'login';
  let busy = false;
  let toastTimer;
  let revision = 0;
  let checking = false;
  async function api(action, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/auth/${action}`, {
        method:body === undefined ? 'GET' : 'POST', credentials:'same-origin',
        cache:'no-store', signal:controller.signal,
        headers:body === undefined ? {} : {'Content-Type':'application/json'},
        body:body === undefined ? undefined : JSON.stringify(body)
      });
      if (!(response.headers.get('Content-Type') || '').includes('application/json'))
        throw new Error('账号服务未部署，请通过 Cloudflare 网站访问。');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试。');
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('请求超时，请重试；注册前可先尝试登录。');
      if (err instanceof TypeError) throw new Error('无法连接账号服务，请检查网络后重试。');
      throw err;
    } finally { clearTimeout(timer); }
  }
  function notify(message) {
    const toast = $('#auth-toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
  function showUser(user) {
    $('#open-login').hidden = !!user;
    $('#open-register').hidden = !!user;
    $('#signed-in').hidden = !user;
    $('#user-name').textContent = user ? user.name : '';
    $('.user-avatar').textContent = user ? Array.from(user.name)[0] : '';
    window.dispatchEvent(new CustomEvent('atlas-auth', {detail:user || null}));
  }
  async function restoreSession() {
    if (busy || checking) return;
    checking = true;
    const current = revision;
    try {
      const data = await api('me');
      if (current === revision) showUser(data.user);
    } catch {
      // A network failure does not prove that the server session has expired.
    } finally { checking = false; }
  }
  function changeMode(next) {
    mode = next;
    form.reset();
    error.textContent = '';
    const register = mode === 'register';
    $('#auth-title').textContent = register ? '开启你的 AI 探索' : '欢迎回来';
    $('#auth-subtitle').textContent = register ? '创建你的账号，开始探索 AI 的更多可能。' : '登录模型之间，继续你的 AI 探索。';
    $('#name-field').hidden = !register;
    $('#confirm-field').hidden = !register;
    $('#email-field').hidden = !register;
    $('#auth-email').required = register;
    $('#auth-name').required = register;
    $('#auth-confirm').required = register;
    $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
    $('#auth-password').type = 'password';
    $('#toggle-password').textContent = '显示';
    $('#toggle-password').setAttribute('aria-label', '显示密码');
    $('#toggle-password').setAttribute('aria-pressed', 'false');
    submit.textContent = register ? '创建账号 ↗' : '登录账号 ↗';
    document.querySelectorAll('[data-auth-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.authMode === mode)));
  }
  function open(next) {
    changeMode(next);
    modal.showModal();
    document.body.classList.add('modal-open');
    (next === 'register' ? $('#auth-name') : $('#auth-account')).focus();
  }
  $('#open-login').addEventListener('click', () => open('login'));
  $('#open-register').addEventListener('click', () => open('register'));
  document.querySelectorAll('[data-auth-mode]').forEach(b => b.addEventListener('click', () => changeMode(b.dataset.authMode)));
  $('.auth-close').addEventListener('click', () => { if (!busy) modal.close(); });
  modal.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  modal.addEventListener('close', () => { form.reset(); error.textContent = ''; document.body.classList.remove('modal-open'); });
  $('#toggle-password').addEventListener('click', () => {
    const reveal = $('#auth-password').type === 'password';
    $('#auth-password').type = reveal ? 'text' : 'password';
    $('#toggle-password').textContent = reveal ? '隐藏' : '显示';
    $('#toggle-password').setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
    $('#toggle-password').setAttribute('aria-pressed', String(reveal));
  });
  form.addEventListener('input', () => { error.textContent = ''; });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy || !form.reportValidity()) return;
    error.textContent = '';
    const account = $('#auth-account').value.trim().toLowerCase();
    const password = $('#auth-password').value;
    const name = $('#auth-name').value.trim();
    const email = $('#auth-email').value.trim();
    if (mode === 'register' && name.length < 2) { error.textContent = '请输入至少 2 个字符的昵称。'; $('#auth-name').focus(); return; }
    if (mode === 'register' && password !== $('#auth-confirm').value) { error.textContent = '两次输入的密码不一致，请重新确认。'; $('#auth-confirm').focus(); return; }
    busy = true;
    revision++;
    // Prevent mode changes while password derivation is in progress.
    const controls = [...modal.querySelectorAll('input, button')];
    controls.forEach(control => { control.disabled = true; });
    submit.textContent = mode === 'register' ? '正在创建…' : '正在登录…';
    try {
      const data = await api(mode, mode === 'register' ? {account, password, name, email} : {account, password});
      showUser(data.user);
      modal.close();
      notify(mode === 'register' ? '注册成功，已为你登录。' : '登录成功，欢迎回来。');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      busy = false;
      controls.forEach(control => { control.disabled = false; });
      submit.textContent = mode === 'register' ? '创建账号 ↗' : '登录账号 ↗';
    }
  });
  $('#logout').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    revision++;
    $('#logout').disabled = true;
    try { await api('logout', {}); showUser(null); notify('已退出登录。'); }
    catch (err) { notify(err.message); }
    finally { busy = false; $('#logout').disabled = false; }
  });
  // Remove obsolete local demo credentials; they are never uploaded or treated as server accounts.
  try { localStorage.removeItem('model-atlas.demo-users.v1'); sessionStorage.removeItem('model-atlas.demo-session.v1'); } catch {}
  window.addEventListener('pageshow', restoreSession);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreSession(); });
  restoreSession();
})();
