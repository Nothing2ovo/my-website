// Browser-only prototype. This is not a server authentication or authorization boundary.
(() => {
  'use strict';
  const USERS = 'model-atlas.demo-users.v1';
  const SESSION = 'model-atlas.demo-session.v1';
  const ITERATIONS = 310000;
  const $ = selector => document.querySelector(selector);
  const modal = $('#auth-dialog');
  const form = $('#auth-form');
  const error = $('#auth-error');
  const submit = $('#auth-submit');
  let mode = 'login';
  let busy = false;
  let toastTimer;
  const encode = bytes => btoa(String.fromCharCode(...bytes));
  const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  function readUsers() {
    const value = JSON.parse(localStorage.getItem(USERS) || '[]');
    if (!Array.isArray(value)) throw new Error('invalid storage');
    return value;
  }
  async function hashPassword(password, salt) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return encode(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt, iterations:ITERATIONS}, key, 256)));
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
  }
  function restoreSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION) || 'null');
      const user = session && session.expires > Date.now() && readUsers().find(u => u.account === session.account);
      showUser(user || null);
      if (!user) sessionStorage.removeItem(SESSION);
    } catch { showUser(null); }
  }
  function changeMode(next) {
    mode = next;
    form.reset();
    error.textContent = '';
    const register = mode === 'register';
    $('#auth-title').textContent = register ? '开启你的 AI 探索' : '欢迎回来';
    $('#auth-subtitle').textContent = register ? '创建一个本地演示账号，体验注册流程。' : '登录模型之间，继续你的 AI 探索。';
    $('#name-field').hidden = !register;
    $('#confirm-field').hidden = !register;
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
    if (!globalThis.crypto?.subtle) {
      error.textContent = '此环境不支持密码处理，请通过 localhost 或 HTTPS 打开页面。';
      return;
    }
    const account = $('#auth-account').value.trim().toLowerCase();
    const password = $('#auth-password').value;
    const name = $('#auth-name').value.trim();
    if (mode === 'register' && name.length < 2) { error.textContent = '请输入至少 2 个字符的昵称。'; $('#auth-name').focus(); return; }
    if (mode === 'register' && password !== $('#auth-confirm').value) { error.textContent = '两次输入的密码不一致，请重新确认。'; $('#auth-confirm').focus(); return; }
    busy = true;
    // Prevent mode changes while password derivation is in progress.
    const controls = [...modal.querySelectorAll('input, button')];
    controls.forEach(control => { control.disabled = true; });
    submit.textContent = mode === 'register' ? '正在创建…' : '正在登录…';
    try {
      let user;
      const users = readUsers();
      const existing = users.find(u => u.account === account);
      if (mode === 'register') {
        if (existing) { error.textContent = '此用户名已注册，请登录或换一个用户名。'; return; }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        user = {account, name, salt:encode(salt), hash:await hashPassword(password, salt)};
        // Re-read after async work to avoid overwriting changes made in another tab.
        const current = readUsers();
        if (current.some(u => u.account === account)) { error.textContent = '此用户名已注册，请登录。'; return; }
        localStorage.setItem(USERS, JSON.stringify([...current, user]));
      } else {
        const salt = existing ? decode(existing.salt) : crypto.getRandomValues(new Uint8Array(16));
        const hash = await hashPassword(password, salt);
        if (!existing || hash !== existing.hash) { error.textContent = '用户名或密码不正确，请重试。'; return; }
        user = existing;
      }
      sessionStorage.setItem(SESSION, JSON.stringify({account:user.account, expires:Date.now() + 12 * 60 * 60 * 1000}));
      showUser(user);
      modal.close();
      notify(mode === 'register' ? '注册成功，已为你登录。' : '登录成功，欢迎回来。');
    } catch {
      error.textContent = '无法读取或保存本地账号，请检查浏览器的网站存储权限后重试。';
    } finally {
      busy = false;
      controls.forEach(control => { control.disabled = false; });
      submit.textContent = mode === 'register' ? '创建账号 ↗' : '登录账号 ↗';
    }
  });
  $('#logout').addEventListener('click', () => {
    try { sessionStorage.removeItem(SESSION); showUser(null); notify('已退出登录。'); }
    catch { notify('暂时无法退出，请检查浏览器存储权限。'); }
  });
  window.addEventListener('storage', restoreSession);
  window.addEventListener('pageshow', restoreSession);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreSession(); });
  restoreSession();
})();
