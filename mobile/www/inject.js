// RHEA-190 ui: injected by the Android app (DropitSharePlugin) into the configured server's web UI,
// only on that origin and only inside the app. Adds one small button with 「从剪贴板发送」 and
// 「应用设置」. The clipboard is read natively, only after a tap, through the DropitApp bridge object
// (WebViewCompat.addWebMessageListener, restricted to the server origin). The text is then posted with
// the page's own session cookie, exactly like the web composer does.
(() => {
  if (window.__dropitAppUi) return;
  window.__dropitAppUi = true;
  const bridge = window.DropitApp;
  const css = (el, s) => { el.style.cssText = s; return el; };
  const hiddenOn = /^\/(setup|device|change-password|s\/)/;

  const root = css(document.createElement('div'), 'position:fixed;right:14px;bottom:calc(88px + env(safe-area-inset-bottom,0px));z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:15px/1.3 system-ui,sans-serif;');
  root.id = 'dropit-app-ui';
  const menu = css(document.createElement('div'), 'display:none;flex-direction:column;gap:6px;background:#fff;color:#111;border:1px solid rgba(0,0,0,.12);border-radius:14px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.18);');
  const item = (label, fn) => {
    const b = css(document.createElement('button'), 'all:unset;display:block;padding:10px 14px;border-radius:10px;cursor:pointer;white-space:nowrap;');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', e => { e.stopPropagation(); open(false); fn(); });
    menu.append(b);
    return b;
  };
  const fab = css(document.createElement('button'), 'all:unset;width:44px;height:44px;border-radius:22px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.25);opacity:.88;cursor:pointer;font-size:20px;');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'dropit 应用菜单');
  fab.textContent = '⇪';
  const toastEl = css(document.createElement('div'), 'position:fixed;left:16px;right:16px;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:2147483001;background:#222;color:#fff;padding:12px 14px;border-radius:10px;font:15px/1.4 system-ui,sans-serif;opacity:0;transition:opacity .2s;pointer-events:none;');
  toastEl.setAttribute('role', 'status');
  let toastTimer;
  const toast = msg => {
    toastEl.textContent = msg;
    toastEl.style.opacity = '.95';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 2600);
  };
  let isOpen = false;
  const open = v => { isOpen = v; menu.style.display = v ? 'flex' : 'none'; };
  fab.addEventListener('click', e => { e.stopPropagation(); open(!isOpen); });
  document.addEventListener('click', () => open(false));

  const errors = {
    TEXT_TOO_LARGE: '文字太长', EMPTY_TEXT: '内容是空的', QUOTA_EXCEEDED: '空间已满', ITEM_LIMIT: '条目数量已达上限',
    RATE_LIMITED: '操作太频繁，请稍后再试', UNAUTHENTICATED: '请先登录', READ_ONLY: '你在这个空间是只读成员',
  };
  const api = async (path, init = {}) => {
    const r = await fetch(path, { credentials: 'same-origin', ...init });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(errors[body?.error?.code] || `请求失败（${body?.error?.code || r.status}）`);
    return body;
  };
  // Same space the board shows (the web keeps it in sessionStorage), else my own private space.
  const targetSpace = async () => {
    const [{ user }, { spaces }] = await Promise.all([api('/api/me'), api('/api/spaces')]);
    const stored = sessionStorage.getItem('dropit-space');
    return (spaces.find(s => s.id === stored) || spaces.find(s => s.ownerId === user.id && s.expiresAt == null) || spaces[0])?.id;
  };
  const deviceHeaders = () => {
    try {
      const d = JSON.parse(localStorage.getItem('dropit-device') || 'null');
      if (d && d.id) return { 'X-Dropit-Device': d.id, 'X-Dropit-Device-Name': encodeURIComponent(d.name || 'Android'), 'X-Dropit-Device-Kind': d.kind || 'phone' };
    } catch { /* no stored device yet */ }
    return {};
  };
  let waiting = null;
  if (bridge) {
    bridge.onmessage = event => {
      let data = null;
      try { data = JSON.parse(event.data); } catch { /* ignore */ }
      if (data?.type === 'clipboard' && waiting) { const w = waiting; waiting = null; w(data); }
    };
  }
  const readClipboard = () => new Promise((resolve, reject) => {
    if (!bridge) { reject(new Error('当前系统 WebView 太旧，不支持读取剪贴板')); return; }
    waiting = resolve;
    setTimeout(() => { if (waiting === resolve) { waiting = null; reject(new Error('读取剪贴板超时')); } }, 5000);
    bridge.postMessage(JSON.stringify({ type: 'clipboard' }));
  });
  let sending = false;
  const sendClipboard = async () => {
    if (sending) return;
    sending = true;
    try {
      const clip = await readClipboard();
      if (clip.error) throw new Error(`读取剪贴板失败：${clip.error}`);
      const text = String(clip.text || '');
      if (!text.trim()) { toast('剪贴板里没有文字（图片请用「分享 → dropit」）'); return; }
      const space = await targetSpace();
      if (!space) throw new Error('没有可用的空间');
      await api(`/api/spaces/${encodeURIComponent(space)}/items/text`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...deviceHeaders() }, body: JSON.stringify({ text }),
      });
      toast('已从剪贴板发送到 dropit');
    } catch (e) {
      toast(e.message || String(e));
    } finally { sending = false; }
  };
  item('从剪贴板发送', sendClipboard);
  item('应用设置（服务器 / 退出）', () => {
    if (bridge) bridge.postMessage(JSON.stringify({ type: 'settings' }));
    else location.href = 'https://localhost/#settings';
  });
  root.append(menu, fab);
  const mount = () => {
    if (!document.body) return;
    if (!root.isConnected) document.body.append(root, toastEl);
    root.style.display = hiddenOn.test(location.pathname) ? 'none' : 'flex';
  };
  mount();
  setInterval(mount, 800);
})();
