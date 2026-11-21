import { pickText } from './i18n.js';
import { ICONS } from './icons.js';
import { renderQrSvg } from './qr.js';

const ALL_PLATFORMS = ['windows', 'linux', 'macos', 'xbox', 'android', 'ios'];
const PLAT_LABELS = {
  ar: {
    windows: 'ويندوز (Windows)',
    linux: 'لينكس (Linux)',
    macos: 'ماك (macOS)',
    xbox: 'إكس بوكس (Xbox)',
    android: 'أندرويد (Android)',
    ios: 'آيفون / آيباد (iOS)'
  },
  en: {
    windows: 'Windows (PC)',
    linux: 'Linux / AppImage',
    macos: 'macOS Universal',
    xbox: 'Xbox Series / One',
    android: 'Android (.APK)',
    ios: 'iPhone / iPad (.IPA)'
  }
};

const cp = {
  lang: localStorage.getItem('oddware_lang') || 'ar',
  theme: localStorage.getItem('oddware_theme') || 'dark',
  token: localStorage.getItem('oddware_auth_token') || localStorage.getItem('oddware_cpanel_token') || '',
  authMeta: { hasAdmin: true, authenticated: false, user: null },
  tab: 'overview',
  editingAppSlug: null,
  draftApp: null,
  editingPostSlug: null,
  otaCheckResult: null,
  otaBusy: false,
  fileBucket: 'releases',
  data: {
    currentAdmin: null,
    siteConfig: {},
    categories: [],
    plugins: [],
    catalog: [],
    posts: [],
    reviews: {},
    users: [],
    system: {}
  }
};

function persistToken(tk) {
  cp.token = tk || '';
  if (tk) {
    localStorage.setItem('oddware_auth_token', tk);
    localStorage.setItem('oddware_cpanel_token', tk);
  } else {
    localStorage.removeItem('oddware_auth_token');
    localStorage.removeItem('oddware_cpanel_token');
  }
}

// Check URL for PySide6 desktop auto-login key or deep-link hash
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('autologin')) {
  persistToken(urlParams.get('autologin'));
}
if (urlParams.get('tab')) {
  cp.tab = urlParams.get('tab');
}
if (window.location.hash === '#apps') {
  cp.tab = 'apps';
  cp.editingAppSlug = '__NEW__';
} else if (window.location.hash === '#posts') {
  cp.tab = 'posts';
  cp.editingPostSlug = '__NEW__';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function t(ar, en) {
  return cp.lang === 'ar' ? ar : en;
}

function toast(msg) {
  const el = document.getElementById('toastEl');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function applyRootAttrs() {
  document.documentElement.lang = cp.lang;
  document.documentElement.dir = cp.lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('data-theme', cp.theme);
  localStorage.setItem('oddware_lang', cp.lang);
  localStorage.setItem('oddware_theme', cp.theme);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), 'X-Admin-Token': cp.token, 'X-Session-Token': cp.token };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) persistToken('');
    await checkAuthMeta();
    render();
    throw new Error('UNAUTHORIZED');
  }
  return res.json();
}

async function checkAuthMeta() {
  try {
    const headers = cp.token ? { 'X-Session-Token': cp.token } : {};
    const res = await fetch('/api/auth/me', { headers });
    cp.authMeta = await res.json();
  } catch (_) {}
}

function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('X-Admin-Token', cp.token);
    xhr.setRequestHeader('X-Session-Token', cp.token);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) {
        const pct = Math.round((e.loaded / e.total) * 100);
        const mb1 = (e.loaded / (1024 * 1024)).toFixed(1);
        const mb2 = (e.total / (1024 * 1024)).toFixed(1);
        onProgress(pct, `${pct}% (${mb1} / ${mb2} MB)`);
      }
    };
    xhr.onload = () => {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch (err) { reject(err); }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(formData);
  });
}

async function refreshState() {
  if (!cp.token) return;
  try {
    cp.data = await api('/api/admin/cpanel-state');
  } catch (_) {}
}

function setProgress(active, pct = 0, label = '') {
  const wrap = document.getElementById('cpGlobalProgress');
  const bar = document.getElementById('cpGlobalProgressBar');
  const lbl = document.getElementById('cpGlobalProgressLabel');
  if (!wrap) return;
  wrap.classList.toggle('active', active);
  if (bar) bar.style.width = `${pct}%`;
  if (lbl) lbl.textContent = label;
}

// ================= FIRST-OWNER SETUP & ADMIN LOGIN SCREEN =================

function renderLogin(root) {
  const isFirstSetup = !cp.authMeta?.hasAdmin;
  const isMemberBlocked = cp.authMeta?.authenticated && cp.authMeta?.user && cp.authMeta.user.role !== 'admin';

  if (isMemberBlocked) {
    root.innerHTML = `
      <div class="cp-login-wrap">
        <div class="cp-login-card" style="text-align:center;">
          <div style="font-size:2.2rem;">🛡️</div>
          <h2 style="font-weight:900;">${t('صلاحية الإدارة مطلوبة', 'Admin Privileges Required')}</h2>
          <p style="font-size:0.9rem;color:var(--text-muted);">
            ${t(
              `أنت مسجّل حالياً بحساب العضو (${cp.authMeta.user.username}). لوحة التحكم مخصّصة لحساب المدير فقط.`,
              `You are signed in as member (${cp.authMeta.user.username}). Control Panel is restricted to Admins.`
            )}
          </p>
          <div style="display:grid;gap:10px;">
            <a href="/" class="brutal-btn volt">${t('← العودة إلى المتجر', '← Back to Store')}</a>
            <button type="button" class="brutal-btn" id="cpSwitchAccBtn">${t('تسجيل الدخول بحساب مدير آخر', 'Sign in with an Admin account')}</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('cpSwitchAccBtn').onclick = async () => {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Session-Token': cp.token } }).catch(() => {});
      persistToken('');
      await checkAuthMeta();
      render();
    };
    return;
  }

  root.innerHTML = `
    <div class="cp-login-wrap">
      <div class="cp-login-card">
        <div style="display:flex;align-items:center;gap:12px;">
          <div class="brand-mark">Ø</div>
          <div>
            <div class="brand-code">ODDWARE // ADMIN</div>
            <h2 style="font-weight:900;font-size:1.25rem;">
              ${isFirstSetup
                ? t('👑 إعداد حساب المدير الأول للمنصة', '👑 First-Time Admin Owner Setup')
                : t('تسجيل دخول مدير المنصة', 'Administrator Sign In')}
            </h2>
          </div>
        </div>

        ${isFirstSetup ? `
          <div class="owner-claim-banner">
            ${t(
              'مرحباً بك! بما أن هذه أول عملية تسجيل على المنصة، فإن اسم المستخدم وكلمة المرور اللذين تختارهما الآن سيصبحان حساب المدير المالك الكامل تلقائياً.',
              'Welcome! Since no accounts exist yet, the username and password you register right now will permanently claim Owner Admin access.'
            )}
          </div>
        ` : `
          <p style="font-size:0.86rem;color:var(--text-muted);">
            ${t('أدخل اسم المستخدم وكلمة المرور الخاصة بحساب المدير للوصول إلى لوحة التحكم الشاملة.', 'Enter your administrator username and password to access the full Control Panel.')}
          </p>
        `}

        <form id="cpLoginForm" style="display:grid;gap:12px;">
          <div class="form-field">
            <label>${t('اسم المستخدم', 'Username')}</label>
            <input type="text" id="cpUserInp" class="brutal-input" placeholder="${t('مثال: mosalah-', 'e.g. mosalah-')}" required minlength="2" autocomplete="username" />
          </div>
          <div class="form-field">
            <label>${t('كلمة المرور', 'Password')}</label>
            <input type="password" id="cpPassInp" class="brutal-input" placeholder="${t('أدخل كلمة المرور...', 'Enter password...')}" required minlength="4" autocomplete="${isFirstSetup ? 'new-password' : 'current-password'}" />
          </div>
          <div id="cpLoginErr" style="display:none;color:#EF4444;font-size:0.84rem;font-weight:700;"></div>
          <button type="submit" class="brutal-btn volt" style="padding:12px;">
            ${isFirstSetup
              ? t('إنشاء حساب المدير وفتح لوحة التحكم ←', 'Create Owner Account & Enter Panel →')
              : t('دخول إلى لوحة التحكم ←', 'Sign In to Control Panel →')}
          </button>
        </form>
        <a href="/" class="brutal-btn" style="text-align:center;">${t('← العودة لواجهة المتجر', '← Back to Public Store')}</a>
      </div>
    </div>
  `;

  document.getElementById('cpLoginForm').onsubmit = async e => {
    e.preventDefault();
    const errEl = document.getElementById('cpLoginErr');
    errEl.style.display = 'none';
    const username = document.getElementById('cpUserInp').value.trim();
    const password = document.getElementById('cpPassInp').value;

    const endpoint = isFirstSetup ? '/api/auth/register' : '/api/admin/login';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const d = await res.json();
    if (res.ok && d.ok && d.token) {
      persistToken(d.token);
      await checkAuthMeta();
      await refreshState();
      render();
      toast(t(`مرحباً ${d.user?.username || username}!`, `Welcome ${d.user?.username || username}!`));
    } else {
      errEl.textContent = d.message || (d.error === 'FORBIDDEN_ADMIN_ONLY'
        ? t('هذا الحساب عضو عادي وليس مدير منصة', 'This account does not have Admin permissions')
        : t('بيانات الدخول غير صحيحة', 'Invalid username or password'));
      errEl.style.display = 'block';
    }
  };
}

// ================= MAIN CPANEL SHELL =================

function render() {
  applyRootAttrs();
  const root = document.getElementById('cpanelRoot');
  if (!cp.token || (cp.authMeta?.authenticated && cp.authMeta?.user?.role !== 'admin') || !cp.data?.system?.port) {
    if (!cp.token || (cp.authMeta?.authenticated && cp.authMeta?.user?.role !== 'admin')) {
      renderLogin(root);
      return;
    }
  }

  const navItems = [
    { id: 'overview', icon: '📊', ar: 'المراقبة والاستضافة', en: 'Server & Tunnels' },
    { id: 'apps', icon: '📦', ar: 'التطبيقات والألعاب', en: 'Apps & Games' },
    { id: 'posts', icon: '📝', ar: 'المواضيع والمقالات', en: 'Articles & Guides' },
    { id: 'themes', icon: '🎨', ar: 'ثيمات ومظهر الموقع', en: 'Site Themes & Skins' },
    { id: 'categories', icon: '🗂️', ar: 'الأقسام والتصنيفات', en: 'Categories' },
    { id: 'users', icon: '👥', ar: 'الأعضاء والصلاحيات', en: 'Users & Roles' },
    { id: 'plugins', icon: '🧩', ar: 'الإضافات والملحقات', en: 'Plugins & Add-ons' },
    { id: 'reviews', icon: '💬', ar: 'التعليقات والتقييمات', en: 'Reviews' },
    { id: 'files', icon: '📁', ar: 'مدير الملفات والتخزين', en: 'File Manager' },
    { id: 'settings', icon: '🔐', ar: 'الهوية والنسخ الاحتياطي', en: 'Branding & Backup' }
  ];

  root.innerHTML = `
    <div class="cp-layout">
      <aside class="cp-sidebar">
        <div>
          <div class="cp-brand-box">
            ${cp.data.siteConfig?.logoUrl
              ? `<img src="${esc(cp.data.siteConfig.logoUrl)}" alt="Logo" style="height:42px;width:42px;object-fit:cover;border-radius:10px;border:1px solid var(--border-base);" />`
              : `<div class="brand-mark">CP</div>`}
            <div>
              <div class="brand-code">${esc(cp.data.siteConfig?.brandCode || 'ADMIN')} // CPANEL</div>
              <strong style="font-size:1.02rem;">${esc(pickText(cp.data.siteConfig?.title, cp.lang) || 'Admin')}</strong>
            </div>
          </div>
          <nav class="cp-nav">
            ${navItems.map(n => `
              <button type="button" class="cp-nav-btn ${cp.tab === n.id ? 'active' : ''}" data-nav="${n.id}">
                <span>${n.icon}</span>
                <span>${esc(cp.lang === 'ar' ? n.ar : n.en)}</span>
              </button>
            `).join('')}
          </nav>
        </div>

        <div class="cp-side-footer">
          <a href="/" target="_blank" class="brutal-btn volt" style="width:100%;">🌐 ${t('فتح الموقع الحي ↗', 'View Live Site ↗')}</a>
          <button type="button" class="brutal-btn" id="cpLogoutBtn" style="width:100%;">🔒 ${t('تسجيل خروج', 'Sign Out')}</button>
        </div>
      </aside>

      <div class="cp-main">
        <header class="cp-topbar">
          <div>
            <strong style="font-size:1.08rem;">${esc(navItems.find(x => x.id === cp.tab)?.[cp.lang] || '')}</strong>
            <span class="mono" style="font-size:0.75rem;color:var(--text-dim);margin-inline-start:10px;">
              NODE: ${esc(cp.data.system?.hostname || 'LOCAL')} • PORT: ${cp.data.system?.port || 8090}
            </span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button type="button" class="upload-action-btn emerald-btn" id="cpTopOtaBtn" style="padding:8px 14px;font-size:0.82rem;">
              ⚡ ${t('تحديث من المستودع (ببصمة)', 'OTA Repo Update')}
            </button>
            <button type="button" class="brutal-btn" id="cpRefreshBtn">🔄 ${t('تحديث', 'Refresh')}</button>
            <button type="button" class="brutal-btn" id="cpThemeBtn">${cp.theme === 'dark' ? '☀ فاتح' : '☾ داكن'}</button>
            <button type="button" class="brutal-btn volt mono" id="cpLangBtn">${cp.lang === 'ar' ? 'EN' : 'عربي'}</button>
          </div>
        </header>

        <div class="cp-workspace">
          <div class="upload-progress-wrap" id="cpGlobalProgress">
            <div class="upload-progress-bar" id="cpGlobalProgressBar"></div>
            <div class="upload-progress-label" id="cpGlobalProgressLabel">0%</div>
          </div>
          <div id="cpTabBody"></div>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-nav]').forEach(btn => {
    btn.onclick = () => {
      cp.tab = btn.getAttribute('data-nav');
      cp.editingAppSlug = null;
      cp.draftApp = null;
      cp.editingPostSlug = null;
      render();
    };
  });

  document.getElementById('cpTopOtaBtn').onclick = async () => {
    cp.tab = 'overview';
    render();
    document.getElementById('otaCheckBtn')?.click();
  };

  document.getElementById('cpRefreshBtn').onclick = async () => {
    await refreshState();
    toast(t('تم تحديث بيانات السيرفر', 'Telemetry refreshed'));
    render();
  };

  document.getElementById('cpThemeBtn').onclick = () => {
    cp.theme = cp.theme === 'dark' ? 'light' : 'dark';
    render();
  };

  document.getElementById('cpLangBtn').onclick = () => {
    cp.lang = cp.lang === 'ar' ? 'en' : 'ar';
    render();
  };

  document.getElementById('cpLogoutBtn').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Session-Token': cp.token } }).catch(() => {});
    persistToken('');
    await checkAuthMeta();
    render();
  };

  const body = document.getElementById('cpTabBody');
  if (cp.tab === 'overview') renderOverviewTab(body);
  else if (cp.tab === 'apps') renderAppsTab(body);
  else if (cp.tab === 'posts') renderPostsTab(body);
  else if (cp.tab === 'themes') renderThemesTab(body);
  else if (cp.tab === 'categories') renderCategoriesTab(body);
  else if (cp.tab === 'users') renderUsersTab(body);
  else if (cp.tab === 'plugins') renderPluginsTab(body);
  else if (cp.tab === 'reviews') renderReviewsTab(body);
  else if (cp.tab === 'files') renderFilesTab(body);
  else if (cp.tab === 'settings') renderSettingsTab(body);
}

// ================= 1. OVERVIEW & HOSTING TELEMETRY =================

function renderOverviewTab(box) {
  const sys = cp.data.system || {};
  const catalog = cp.data.catalog || [];
  const posts = cp.data.posts || [];
  const plugins = cp.data.plugins || [];
  const totalDls = catalog.reduce((s, x) => s + (x.stats?.totalDownloads || 0), 0);
  const usedMemMb = Math.max(0, (sys.memTotalMb || 0) - (sys.memFreeMb || 0));
  const memPct = sys.memTotalMb ? Math.round((usedMemMb / sys.memTotalMb) * 100) : 0;

  const onionFull = sys.torOnion ? `http://${sys.torOnion}` : 'Generating...';
  const cfFull = sys.cloudflareUrl || 'Not active yet';
  const lanFull = sys.lanUrl || `http://127.0.0.1:${sys.port || 8090}`;
  const cfg = cp.data.siteConfig || {};

  box.innerHTML = `
    <div style="display:grid;gap:20px;">
      <!-- FRONT-AND-CENTER SITE ICON & NAME BAR ON FIRST SCREEN -->
      <div class="cp-card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;border-color:var(--border-strong);">
        <div style="display:flex;align-items:center;gap:14px;">
          ${cfg.logoUrl
            ? `<img src="${esc(cfg.logoUrl)}" alt="Logo" style="height:54px;width:54px;object-fit:contain;border-radius:12px;border:1px solid var(--border-base);" />`
            : `<div class="brand-mark" style="width:52px;height:52px;">${esc((cfg.brandCode || 'Ø').slice(0, 2))}</div>`}
          <div>
            <strong style="font-size:1.05rem;display:block;">🖼️ ${t('أيقونة ولوجو الموقع واسم المنصة:', 'Site Logo, Icon & Brand Name:')} ${esc(pickText(cfg.title, cp.lang))}</strong>
            <span style="font-size:0.82rem;color:var(--text-muted);">${t('ارفع أيقونة موقعك الجديدة أو غيّر اسم الموقع والثيم بضغطة واحدة', 'Upload your custom logo/icon or switch site themes instantly')}</span>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <label class="upload-action-btn" style="padding:10px 18px;">
            📤 ${t('رفع أيقونة / لوجو الموقع الآن', 'Upload Site Icon / Logo')}
            <input type="file" id="ovQuickLogoInp" accept="image/*" style="display:none;" />
          </label>
          <button type="button" class="brutal-btn" id="ovGoThemesBtn">🎨 ${t('تغيير الاسم والثيمات', 'Edit Name & Themes')}</button>
        </div>
      </div>

      <!-- CRYPTOGRAPHIC SHA-256 REPOSITORY OTA UPDATER -->
      <div class="cp-card" id="otaUpdaterCard" style="border:1.5px solid var(--accent-emerald);">
        <div class="cp-card-title">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span>🔐 ${t('التحديث المباشر المتصل بالمستودع بالبصمة الرقمية (SHA-256 OTA Updater)', 'Cryptographic SHA-256 Repository Updater (Zero Repackaging)')}</span>
            <span class="tag-pill mono" style="color:var(--accent-emerald);">v${esc(cp.data.ota?.version || '3.3.0')} (#${cp.data.ota?.buildSeq || 0})</span>
          </div>
          <div class="ota-repo-row" style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:12px;align-items:end;">
            <div class="form-field" style="margin:0;">
              <label style="font-size:0.8rem;">${t('رابط المستودع (اتركه فاضي للافتراضي)', 'Repository raw URL (leave empty for default)')}</label>
              <input class="brutal-input mono" id="otaRepoUrlInp" style="font-size:0.78rem;"
                     value="${esc(cfg.network?.otaRepoRawUrl || '')}"
                     placeholder="https://gitlab.com/itlab/your-repo/-/raw/main" />
            </div>
            <button type="button" class="brutal-btn volt" id="otaSaveRepoBtn">💾 ${t('حفظ', 'Save')}</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="brutal-btn" id="otaCheckBtn" ${cp.otaBusy ? 'disabled' : ''}>
              🔍 ${t('فحص التحديثات بالمستودع', 'Check Repository for Updates')}
            </button>
            <button type="button" class="upload-action-btn emerald-btn" id="otaApplyBtn" style="padding:9px 16px;font-size:0.84rem;" ${cp.otaBusy ? 'disabled' : ''}>
              ⬇️ ${t('سحب وتثبيت أحدث نسخة بالبصمة فوراً', 'Pull & Verify Latest Update Now')}
            </button>
            ${cp.data.ota?.hasRollback ? `
              <button type="button" class="brutal-btn signal" id="otaRollbackBtn" ${cp.otaBusy ? 'disabled' : ''}>
                ↩️ ${t('تراجع للنسخة السابقة', 'Rollback')}
              </button>
            ` : ''}
          </div>
        </div>

        <div style="display:grid;gap:10px;font-size:0.85rem;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:10px;background:var(--bg-input);border:1px solid var(--border-base);">
            <span>🛡️ <strong>${t('البصمة الرقمية الحالية على جهازك (Local SHA-256):', 'Active Local SHA-256 Fingerprint:')}</strong></span>
            <span class="mono" style="font-size:0.76rem;color:var(--accent-emerald);word-break:break-all;">
              ${esc(cp.data.ota?.bundleSha256 || '—')}
            </span>
          </div>

          <div id="otaCheckStatusBox">
            ${cp.otaCheckResult ? (
              cp.otaCheckResult.ok ? `
                <div style="padding:14px;border-radius:12px;background:var(--bg-panel-alt);border:1px solid ${cp.otaCheckResult.updateAvailable ? 'var(--accent-emerald)' : 'var(--border-base)'};display:grid;gap:8px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                    <strong style="color:${cp.otaCheckResult.updateAvailable ? 'var(--accent-emerald)' : 'var(--text-main)'};">
                      ${cp.otaCheckResult.updateAvailable
                        ? `🚀 ${t(`يوجد تحديث جديد بالمستودع! (${cp.otaCheckResult.changedFilesCount} ملفات متغيرة — ${cp.otaCheckResult.totalDownloadFormatted})`, `New Verified Update Available! (${cp.otaCheckResult.changedFilesCount} files — ${cp.otaCheckResult.totalDownloadFormatted})`)}`
                        : `✅ ${t('نسختك الحالية مطابقة 100% لبصمة المستودع الرسمية ولا تحتاج تحديث!', 'Your system matches 100% of the official repository SHA-256 fingerprint!')}`}
                    </strong>
                    <span class="mono" style="font-size:0.78rem;">Remote: v${esc(cp.otaCheckResult.remote?.version)} (#${cp.otaCheckResult.remote?.buildSeq})</span>
                  </div>
                  <div class="mono" style="font-size:0.74rem;color:var(--text-muted);word-break:break-all;">
                    Remote SHA-256: ${esc(cp.otaCheckResult.remote?.bundleSha256)}
                  </div>
                  ${pickText(cp.otaCheckResult.remote?.notes, cp.lang) ? `
                    <div style="font-size:0.84rem;">📋 ${esc(pickText(cp.otaCheckResult.remote?.notes, cp.lang))}</div>
                  ` : ''}
                  ${(cp.otaCheckResult.changedFiles || []).length > 0 ? `
                    <div class="mono" style="font-size:0.74rem;color:var(--text-muted);max-height:95px;overflow-y:auto;padding:8px;background:var(--bg-input);border-radius:8px;">
                      ${cp.otaCheckResult.changedFiles.map(f => `• [${esc(f.status)}] ${esc(f.path)} (sha256: ${esc(f.sha256.slice(0, 12))}…)`).join('<br/>')}
                    </div>
                  ` : ''}
                </div>
              ` : `
                <div style="color:#EF4444;font-weight:700;">⚠️ ${esc(cp.otaCheckResult.error || 'تعذر الاتصال بالمستودع')}</div>
              `
            ) : `
              <div style="color:var(--text-muted);font-size:0.82rem;">
                ${t(
                  'أي تعديل أو ميزة جديدة نرفعها للمستودع يمكنك سحبها وتثبيتها من هنا في ثوانٍ بعد فحص بصمة SHA-256 لكل ملف، مع الاحتفاظ الكامل بجميع تطبيقاتك وأعضائك وإعداداتك دون الحاجة لتحزيم إصدار جديد.',
                  'Pull any future feature or UI update directly from the repository with strict per-file SHA-256 verification — zero repackaging required and 100% of your apps, users, and settings remain intact.'
                )}
              </div>
            `}
          </div>
        </div>
      </div>

      <div class="cp-kpi-grid">
        <div class="cp-kpi-card">
          <span class="cp-kpi-val">${catalog.length}</span>
          <strong>${t('تطبيقات وألعاب منشورة', 'Published Apps & Games')}</strong>
        </div>
        <div class="cp-kpi-card">
          <span class="cp-kpi-val">${posts.length}</span>
          <strong>${t('مواضيع ومقالات تقنية', 'Published Topics & Posts')}</strong>
        </div>
        <div class="cp-kpi-card">
          <span class="cp-kpi-val">${totalDls.toLocaleString()}</span>
          <strong>${t('إجمالي عمليات التحميل', 'Total Package Downloads')}</strong>
        </div>
        <div class="cp-kpi-card">
          <span class="cp-kpi-val">${plugins.filter(p => p.enabled).length}/${plugins.length}</span>
          <strong>${t('إضافات مفعلة نشطة', 'Active Extensions')}</strong>
        </div>
      </div>

      <div class="cp-card">
        <div class="cp-card-title">
          <span>🌐 ${t('بوابات الاستضافة الحية على جهازك (LAN + Cloudflare + Tor)', 'Live Self-Hosted Gateways (LAN + Cloudflare + Tor)')}</span>
          <div style="display:flex;gap:8px;">
            <button type="button" class="brutal-btn volt" id="quickNewAppBtn">+ ${t('نشر تطبيق / لعبة جديدة', 'Publish App / Game')}</button>
            <button type="button" class="brutal-btn signal" id="quickNewPostBtn">+ ${t('كتابة موضوع جديد', 'Write New Topic')}</button>
          </div>
        </div>
        <div class="nodes-grid" style="margin-top:8px;">
          <div class="node-card">
            <strong>🖥️ ${t('استضافة الشبكة المحلية (Local / LAN Port)', 'Local & LAN Host Endpoint')}</strong>
            <div class="node-endpoint">${esc(lanFull)}</div>
            <div style="background:#FFF;padding:8px;width:fit-content;margin:auto;border:2px solid #000;">${renderQrSvg(lanFull, 128)}</div>
            <button type="button" class="brutal-btn" data-copy="${esc(lanFull)}">${t('نسخ رابط الشبكة', 'Copy LAN URL')}</button>
          </div>
          <div class="node-card">
            <strong style="color:var(--accent-signal);">☁️ ${t('نفق Cloudflare العام المؤقت / الدائم', 'Cloudflare Public HTTPS Tunnel')}</strong>
            <div class="node-endpoint">${esc(cfFull)}</div>
            ${cfFull.startsWith('http') ? `<div style="background:#FFF;padding:8px;width:fit-content;margin:auto;border:2px solid #000;">${renderQrSvg(cfFull, 128)}</div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;">
              <button type="button" class="brutal-btn" data-copy="${esc(cfFull)}">${t('نسخ رابط Cloudflare', 'Copy Cloudflare URL')}</button>
              <button type="button" class="brutal-btn signal" id="cpRestartCfBtn">🔄 ${t('إعادة توليد الرابط', 'Restart Tunnel')}</button>
            </div>
          </div>
          <div class="node-card">
            <strong style="color:var(--accent-tor);">🧅 ${t('خدمة Tor الخفية (.onion)', 'Tor Hidden Service (.onion)')} ${sys.torBootstrap ? `(${sys.torBootstrap}%)` : ''}</strong>
            <div class="node-endpoint" style="color:var(--accent-tor);">${esc(onionFull)}</div>
            ${onionFull.startsWith('http') ? `<div style="background:#FFF;padding:8px;width:fit-content;margin:auto;border:2px solid #000;">${renderQrSvg(onionFull, 128)}</div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;">
              <button type="button" class="brutal-btn tor-pill" data-copy="${esc(onionFull)}">${t('نسخ رابط Tor', 'Copy .onion URL')}</button>
              <button type="button" class="brutal-btn" id="cpRestartTorBtn">🔄 ${t('تشغيل / تحديث Tor', 'Start / Refresh Tor')}</button>
              <button type="button" class="brutal-btn" id="cpRotateTorBtn">🔑 ${t('عنوان .onion جديد', 'New .onion')}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="specs-two-col" style="margin-bottom:0;">
        <div class="cp-card">
          <div class="cp-card-title">⚙️ ${t('موارد الجهاز والسيرفر المضيف', 'Host Hardware & Storage Telemetry')}</div>
          <div class="reqs-grid">
            <div class="req-row"><strong>OS / Arch:</strong> <span class="mono">${esc(sys.platform)}</span></div>
            <div class="req-row"><strong>CPU Cores / Load:</strong> <span class="mono">${sys.cpus || 1} Cores (${(sys.loadAvg || []).join(' / ')})</span></div>
            <div class="req-row">
              <div style="width:100%;">
                <div style="display:flex;justify-content:space-between;">
                  <strong>RAM Usage:</strong>
                  <span class="mono">${usedMemMb} MB / ${sys.memTotalMb} MB (${memPct}%)</span>
                </div>
                <div class="meter-track"><div class="meter-fill" style="width:${memPct}%"></div></div>
              </div>
            </div>
            <div class="req-row"><strong>${t('حجم الحزم المرفوعة:', 'Hosted Packages Size:')}</strong> <span class="mono">${esc(sys.releasesFormatted || '0 B')} (${sys.releasesCount || 0} files)</span></div>
            <div class="req-row"><strong>Data Path:</strong> <span class="mono" style="font-size:0.74rem;">${esc(sys.dataDir)}</span></div>
          </div>
        </div>

        <div class="cp-card">
          <div class="cp-card-title">📈 ${t('توزيع التحميلات حسب نظام التشغيل', 'Downloads Breakdown by Target OS')}</div>
          <div class="reqs-grid">
            ${ALL_PLATFORMS.map(pk => {
              const sum = catalog.reduce((s, x) => s + (x.stats?.downloads?.[pk] || 0), 0);
              const pct = totalDls ? Math.round((sum / totalDls) * 100) : 0;
              return `
                <div class="req-row" style="flex-direction:column;gap:4px;">
                  <div style="display:flex;justify-content:space-between;">
                    <span>${ICONS[pk]} <strong>${esc(PLAT_LABELS[cp.lang][pk])}</strong></span>
                    <span class="mono">${sum.toLocaleString()} (${pct}%)</span>
                  </div>
                  <div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  box.querySelectorAll('[data-copy]').forEach(btn => {
    btn.onclick = () => {
      navigator.clipboard?.writeText(btn.getAttribute('data-copy'));
      toast(t('تم نسخ الرابط!', 'Copied URL!'));
    };
  });
  const restartCfBtn = document.getElementById('cpRestartCfBtn');
  if (restartCfBtn) {
    restartCfBtn.onclick = async () => {
      toast(t('جاري توليد نفق Cloudflare جديد...', 'Restarting Cloudflare tunnel...'));
      await api('/api/admin/daemons/restart-cloudflare', { method: 'POST' });
      setTimeout(async () => { await refreshState(); render(); }, 3500);
    };
  }
  const restartTorBtn = document.getElementById('cpRestartTorBtn');
  if (restartTorBtn) {
    restartTorBtn.onclick = async () => {
      toast(t('جاري تشغيل وتحديث خدمة Tor الخفية...', 'Starting/refreshing Tor service...'));
      await api('/api/admin/daemons/restart-tor', { method: 'POST' });
      setTimeout(async () => { await refreshState(); render(); }, 2500);
    };
  }
  const rotateTorBtn = document.getElementById('cpRotateTorBtn');
  if (rotateTorBtn) {
    rotateTorBtn.onclick = async () => {
      toast(t('جاري توليد عنوان .onion جديد كلياً...', 'Generating brand-new .onion identity...'));
      await api('/api/admin/daemons/rotate-onion', { method: 'POST' });
      setTimeout(async () => { await refreshState(); render(); }, 2500);
    };
  }
  document.getElementById('ovQuickLogoInp')?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('slug', 'site-logo');
    fd.append('file', f);
    const d = await uploadWithProgress('/api/admin/upload/media', fd, (p, l) => setProgress(true, p, `🖼️ ${l}`));
    setProgress(false);
    if (d.ok) {
      await api('/api/admin/site-config', { method: 'PUT', body: JSON.stringify({ logoUrl: d.mediaUrl }) });
      await refreshState();
      toast(t('🎉 تم رفع وتفعيل أيقونة الموقع بنجاح!', '🎉 Site icon uploaded & activated!'));
      render();
    }
  });

  document.getElementById('ovGoThemesBtn')?.addEventListener('click', () => {
    cp.tab = 'themes';
    render();
  });

  document.getElementById('otaSaveRepoBtn')?.addEventListener('click', async () => {
    const inp = document.getElementById('otaRepoUrlInp');
    const url = (inp?.value || '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      toast(t('⚠️ الرابط يجب أن يبدأ بـ https://', '⚠️ URL must start with https://'), 5000);
      return;
    }
    await api('/api/admin/site-config', {
      method: 'PUT',
      body: JSON.stringify({ network: { otaRepoRawUrl: url } })
    });
    await refreshState();
    toast(t('✅ تم حفظ رابط المستودع', '✅ Repository URL saved'));
    render();
  });

  document.getElementById('otaCheckBtn')?.addEventListener('click', async () => {
    cp.otaBusy = true;
    const statusBox = document.getElementById('otaCheckStatusBox');
    if (statusBox) {
      statusBox.innerHTML = `<span style="color:var(--accent-primary);font-weight:700;">⏳ ${t('جاري الاتصال بالمستودع وفحص البصمة الرقمية SHA-256...', 'Checking repository SHA-256 manifest...')}</span>`;
    }
    try {
      // v3 engine: reports the real reason and every repository URL it tried
      cp.otaCheckResult = await api('/api/admin/ota/v3/check');
      if (cp.otaCheckResult.ok === false) {
        toast(`⚠️ ${cp.otaCheckResult.message || t('فشل الفحص', 'Check failed')}`, 6000);
      } else if (cp.otaCheckResult.updateAvailable) {
        toast(t('🚀 تم العثور على تحديث جديد موثّق بالبصمة!', '🚀 Verified update available!'));
      } else {
        toast(t('✅ نسختك محدّثة بالكامل ومطابقة للبصمة!', '✅ Already on latest verified build!'));
      }
    } catch (err) {
      cp.otaCheckResult = { ok: false, message: err.message };
      toast(`⚠️ ${err.message}`, 6000);
    }
    cp.otaBusy = false;
    render();
  });

  document.getElementById('otaApplyBtn')?.addEventListener('click', async () => {
    cp.otaBusy = true;
    setProgress(true, 45, `🔐 ${t('جاري تحميل الملفات والتحقق من البصمة الرقمية SHA-256...', 'Downloading & verifying SHA-256 fingerprints...')}`);
    try {
      const res = await api('/api/admin/ota/v3/apply', { method: 'POST' });
      if (res.ok) {
        setProgress(true, 100, `✅ ${t('اكتمل التحقق من البصمة! جاري إعادة التشغيل السريع...', 'SHA-256 Verified! Hot-reloading...')}`);
        toast(t(`🎉 تم التحديث بنجاح إلى v${res.version}! جاري تحديث الواجهة...`, `🎉 Updated to v${res.version}! Reloading...`));
        setTimeout(() => window.location.reload(), 1600);
        return;
      } else {
        setProgress(false);
        // show the real reason instead of a generic failure
        const msg = res.message || res.error || t('فشل التحديث', 'Update failed');
        cp.otaCheckResult = { ok: false, message: msg, code: res.code, tried: res.tried };
        toast(`⚠️ ${msg}`, 8000);
        render();
      }
    } catch (err) {
      setProgress(false);
      toast(`⚠️ ${err.message}`, 8000);
    }
    cp.otaBusy = false;
  });

  document.getElementById('otaRollbackBtn')?.addEventListener('click', async () => {
    if (!confirm(t('هل تريد استرجاع النسخة السابقة؟', 'Rollback to previous build?'))) return;
    await api('/api/admin/ota/rollback', { method: 'POST' });
    toast(t('↩️ جاري استرجاع النسخة السابقة...', 'Rolling back...'));
    setTimeout(() => window.location.reload(), 1500);
  });

  document.getElementById('quickNewAppBtn').onclick = () => {
    cp.tab = 'apps';
    cp.editingAppSlug = '__NEW__';
    cp.draftApp = null;
    render();
  };
  document.getElementById('quickNewPostBtn').onclick = () => {
    cp.tab = 'posts';
    cp.editingPostSlug = '__NEW__';
    render();
  };
}

// ================= 2. APPS & GAMES MULTI-PLATFORM PUBLISHER =================

function insertMdTag(textarea, prefix, suffix = '') {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const sel = textarea.value.slice(start, end) || 'نص';
  textarea.value = textarea.value.slice(0, start) + prefix + sel + suffix + textarea.value.slice(end);
  textarea.focus();
}

function renderAppsTab(box) {
  const categories = cp.data.categories || [];
  if (cp.editingAppSlug) {
    const isNew = cp.editingAppSlug === '__NEW__';
    if (!cp.draftApp || (!isNew && cp.draftApp.slug !== cp.editingAppSlug)) {
      cp.draftApp = isNew ? {
        slug: '',
        code: `APP-0${cp.data.catalog.length + 1}`,
        status: 'published',
        category: categories[0]?.slug || 'indie-game',
        featured: false,
        channel: 'stable',
        license: { ar: 'مجاني • إصدار مستقل', en: 'Freeware • Indie Build' },
        version: 'v1.0.0',
        releaseDate: new Date().toISOString().slice(0, 10),
        techStack: 'Multi-Platform Native',
        trailerUrl: '',
        cover: '/assets/covers/ui-crypto-app.jpg',
        screenshots: [],
        title: { ar: '', en: '' },
        tagline: { ar: '', en: '' },
        description: { ar: '', en: '' },
        highlights: { ar: [], en: [] },
        changelog: { ar: [], en: [] },
        tags: { ar: [], en: [] },
        requirements: {
          os: { ar: 'Windows • Linux • macOS • Android • iOS', en: 'Windows • Linux • macOS • Android • iOS' },
          cpu: 'Dual-Core 2.0GHz+',
          gpu: 'Vulkan / OpenGL 3.3 / Metal',
          ram: '4 GB RAM',
          disk: '250 MB',
          arch: 'x86_64 / ARM64'
        },
        optionalDemo: { enabled: false, url: '' },
        extraLinks: [],
        platforms: {}
      } : JSON.parse(JSON.stringify(cp.data.catalog.find(x => x.slug === cp.editingAppSlug) || {}));
    }

    const item = cp.draftApp;

    const syncFormIntoDraft = () => {
      const formEl = document.getElementById('cpAppForm');
      if (!formEl) return item;
      const fd = new FormData(formEl);
      const splitLines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
      const splitTags = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

      const titleAr = (fd.get('title_ar') || '').trim();
      const titleEn = (fd.get('title_en') || '').trim() || titleAr;
      const tagAr = (fd.get('tagline_ar') || '').trim();
      const tagEn = (fd.get('tagline_en') || '').trim() || tagAr;
      const descAr = (fd.get('desc_ar') || '').trim();
      const descEn = (fd.get('desc_en') || '').trim() || descAr;
      const hlAr = splitLines(fd.get('hl_ar'));
      const hlEn = splitLines(fd.get('hl_en'));
      const clAr = splitLines(fd.get('cl_ar'));

      item.slug = (fd.get('slug') || item.slug || '').trim();
      item.code = (fd.get('code') || item.code || `APP-0${cp.data.catalog.length + 1}`).trim();
      item.status = fd.get('status') || 'published';
      item.version = (fd.get('version') || 'v1.0.0').trim();
      item.channel = fd.get('channel') || 'stable';
      item.category = fd.get('category') || categories[0]?.slug || 'indie-game';
      item.featured = fd.get('featured') === 'on';
      item.releaseDate = fd.get('releaseDate') || item.releaseDate || new Date().toISOString().slice(0, 10);
      item.techStack = (fd.get('techStack') || item.techStack || '').trim();
      item.cover = (fd.get('cover') || item.cover || '/assets/covers/ui-crypto-app.jpg').trim();
      item.trailerUrl = (fd.get('trailerUrl') || item.trailerUrl || '').trim();
      item.title = { ar: titleAr, en: titleEn };
      item.tagline = { ar: tagAr, en: tagEn };
      item.description = { ar: descAr, en: descEn };
      item.highlights = { ar: hlAr, en: hlEn.length ? hlEn : hlAr };
      item.changelog = { ar: clAr, en: clAr };
      item.tags = { ar: splitTags(fd.get('tags_ar')), en: splitTags(fd.get('tags_en') || fd.get('tags_ar')) };
      item.requirements = {
        os: { ar: fd.get('req_os_ar') || item.requirements?.os?.ar || '', en: fd.get('req_os_ar') || '' },
        cpu: fd.get('req_cpu') || item.requirements?.cpu || '',
        ram: fd.get('req_ram') || item.requirements?.ram || '',
        gpu: fd.get('req_gpu') || item.requirements?.gpu || '',
        disk: fd.get('req_disk') || item.requirements?.disk || '',
        arch: fd.get('req_arch') || item.requirements?.arch || ''
      };
      item.optionalDemo = {
        enabled: fd.get('opt_demo_on') === 'on',
        url: (fd.get('opt_demo_url') || '').trim()
      };

      ALL_PLATFORMS.forEach(pk => {
        const chk = document.querySelector(`[data-ptoggle="${pk}"]`);
        const extInp = document.getElementById(`pExt_${pk}`);
        const sizeInp = document.getElementById(`pSize_${pk}`);
        const fmtInp = document.getElementById(`pFmt_${pk}`);
        if (chk || extInp) {
          const prev = item.platforms?.[pk] || {};
          const extVal = extInp ? extInp.value.trim() : (prev.externalUrl || '');
          item.platforms[pk] = {
            ...prev,
            available: chk ? (chk.checked || Boolean(extVal)) : Boolean(prev.available),
            externalUrl: extVal,
            size: sizeInp?.value.trim() || prev.size || '—',
            format: fmtInp?.value.trim() || prev.format || pk.toUpperCase()
          };
        }
      });

      return item;
    };

    const ensureSavedOnServer = async () => {
      syncFormIntoDraft();
      if (!item.title?.ar && !item.title?.en) {
        item.title = { ar: 'تطبيق جديد', en: 'New App' };
      }
      const res = await api('/api/admin/catalog', { method: 'POST', body: JSON.stringify(item) });
      if (res.ok && res.item) {
        await refreshState();
        cp.editingAppSlug = res.item.slug;
        cp.draftApp = JSON.parse(JSON.stringify(res.item));
        return res.item;
      }
      throw new Error('SAVE_FAILED');
    };

    const isYtVideo = /(?:youtube\.com|youtu\.be)/i.test(item.trailerUrl || '');

    box.innerHTML = `
      <form id="cpAppForm" style="display:grid;gap:22px;">
        <!-- TOP ACTION BAR -->
        <div class="cp-card" style="padding:16px 22px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;">
            <button type="button" class="brutal-btn" id="backAppsListBtn">← ${t('العودة للقائمة', 'Back')}</button>
            <strong style="font-size:1.08rem;">
              ${isNew
                ? '🚀 ' + t('نشر تطبيق أو لعبة جديدة بخطوة واحدة سهلة', 'Easy Single-Page App & Game Publisher')
                : '✏️ ' + t('تعديل:', 'Editing:') + ' ' + esc(pickText(item.title, cp.lang) || item.slug)}
            </strong>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            ${!isNew ? `<a href="/#project/${esc(item.slug)}" target="_blank" class="brutal-btn">👁️ ${t('معاينة بالمتجر ↗', 'Preview ↗')}</a>` : ''}
            ${!isNew ? `<button type="button" class="brutal-btn signal" id="cpDelAppBtn">🗑️ ${t('حذف', 'Delete')}</button>` : ''}
            <button type="submit" class="brutal-btn volt" style="padding:11px 24px;font-size:0.95rem;">
              💾 ${t('حفظ ونشر في المتجر الآن', 'Save & Publish Now')}
            </button>
          </div>
        </div>

        <!-- STEP 1: EASY CORE DETAILS -->
        <div class="cp-card">
          <div class="cp-card-title">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="pub-step-badge">1</span>
              <span>${t('بيانات التطبيق أو اللعبة الأساسية (اكتب بالعربية فقط والباقي يتم تلقائياً!)', 'Step 1: Basic App / Game Info')}</span>
            </div>
            <label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;cursor:pointer;">
              <input type="checkbox" name="featured" ${item.featured ? 'checked' : ''} />
              ⭐ ${t('تثبيت في واجهة المتجر الرئيسية', 'Feature on Homepage')}
            </label>
          </div>

          <div class="form-grid">
            <div class="form-field">
              <label>${t('اسم التطبيق أو اللعبة *', 'App or Game Title *')}</label>
              <input class="brutal-input" name="title_ar" value="${esc(item.title?.ar)}"
                     placeholder="${t('مثال: لعبة صقر الصحراء أو برنامج مسرّع النظام', 'e.g. Desert Hawk Game or System Booster')}" required />
            </div>

            <div class="form-field">
              <label>${t('القسم / الإصدار / حالة النشر', 'Category / Version / Status')}</label>
              <div style="display:grid;grid-template-columns:1.4fr 0.8fr 0.9fr;gap:8px;">
                <select class="brutal-select" name="category">
                  ${categories.map(c => `<option value="${esc(c.slug)}" ${item.category === c.slug ? 'selected' : ''}>${esc(c.icon)} ${esc(pickText(c.name, cp.lang))}</option>`).join('')}
                </select>
                <input class="brutal-input mono" name="version" value="${esc(item.version || 'v1.0.0')}" placeholder="v1.0.0" />
                <select class="brutal-select" name="status">
                  <option value="published" ${item.status !== 'draft' ? 'selected' : ''}>🟢 ${t('منشور فوراً', 'Published')}</option>
                  <option value="draft" ${item.status === 'draft' ? 'selected' : ''}>📝 ${t('مسودة', 'Draft')}</option>
                </select>
              </div>
            </div>

            <div class="form-field full">
              <label>${t('سطر تعريفي سريع يظهر على البطاقة', 'Short Tagline / Summary')}</label>
              <input class="brutal-input" name="tagline_ar" value="${esc(item.tagline?.ar)}"
                     placeholder="${t('وصف قصير جذاب في جملة واحدة...', 'A catchy one-line summary...')}" />
            </div>

            <div class="form-field full">
              <label>${t('الوصف الكامل للتطبيق أو اللعبة (يدعم العناوين والنقاط)', 'Full Description')}</label>
              <div class="md-toolbar">
                <button type="button" class="md-tool-btn" data-md="### ">H3 عنوان</button>
                <button type="button" class="md-tool-btn" data-md="**" data-mds="**">B عريض</button>
                <button type="button" class="md-tool-btn" data-md="\n- ">• قائمة نقاط</button>
                <button type="button" class="md-tool-btn" data-md="&#96;" data-mds="&#96;">Code كود</button>
              </div>
              <textarea class="brutal-input" id="descArArea" style="min-height:115px;border-top-left-radius:0;border-top-right-radius:0;" name="desc_ar"
                        placeholder="${t('اشرح فكرة اللعبة أو التطبيق وطريقة التشغيل وأهم المزايا...', 'Describe features, gameplay, or instructions...')}">${esc(item.description?.ar)}</textarea>
            </div>

            <div class="form-field">
              <label>${t('أبرز المميزات (ميزة في كل سطر — اختياري)', 'Key Highlights (One per line — optional)')}</label>
              <textarea class="brutal-input" style="min-height:82px;" name="hl_ar"
                        placeholder="${t('يدعم اللغة العربية بالكامل\nيعمل بدون إنترنت\nأداء فائق السرعة', 'Fast native engine\nOffline support')}">${esc((item.highlights?.ar || []).join('\n'))}</textarea>
            </div>

            <div class="form-field">
              <label>${t('الجديد في هذا الإصدار (اختياري)', 'What\'s New / Changelog (Optional)')}</label>
              <textarea class="brutal-input" style="min-height:82px;" name="cl_ar"
                        placeholder="${t('إصدار أول مستقر\nتحسين الرسوميات والأداء', 'Initial stable release')}">${esc((item.changelog?.ar || []).join('\n'))}</textarea>
            </div>
          </div>

          <!-- COLLAPSIBLE OPTIONAL ADVANCED & ENGLISH DRAWER -->
          <details class="adv-drawer" style="margin-top:14px;">
            <summary>⚙️ ${t('إعدادات إضافية وترجمة إنجليزية مخصصة ومتطلبات التشغيل (اختياري تماماً)', 'Optional: Custom English Translation, URL Slug & Hardware Specs')}</summary>
            <div class="form-grid" style="margin-top:14px;">
              <div class="form-field">
                <label>English Title (Optional — auto-filled if blank)</label>
                <input class="brutal-input" name="title_en" value="${esc(item.title?.en)}" placeholder="Auto-filled from Arabic if empty" />
              </div>
              <div class="form-field">
                <label>URL Slug (Optional — auto-generated)</label>
                <input class="brutal-input mono" name="slug" value="${esc(item.slug)}" placeholder="auto-generated-slug" ${isNew ? '' : 'readonly'} />
              </div>
              <div class="form-field">
                <label>English Tagline</label>
                <input class="brutal-input" name="tagline_en" value="${esc(item.tagline?.en)}" />
              </div>
              <div class="form-field">
                <label>${t('الكود / قناة الإطلاق / تاريخ النشر', 'Code / Channel / Release Date')}</label>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
                  <input class="brutal-input mono" name="code" value="${esc(item.code)}" />
                  <select class="brutal-select" name="channel">
                    <option value="stable" ${item.channel === 'stable' ? 'selected' : ''}>Stable</option>
                    <option value="beta" ${item.channel === 'beta' ? 'selected' : ''}>Beta</option>
                    <option value="experimental" ${item.channel === 'experimental' ? 'selected' : ''}>Experimental</option>
                  </select>
                  <input type="date" class="brutal-input" name="releaseDate" value="${esc(item.releaseDate)}" />
                </div>
              </div>
              <div class="form-field full">
                <label>English Full Description</label>
                <textarea class="brutal-input" style="min-height:80px;" name="desc_en">${esc(item.description?.en)}</textarea>
              </div>
              <div class="form-field">
                <label>English Highlights (1 per line)</label>
                <textarea class="brutal-input" style="min-height:68px;" name="hl_en">${esc((item.highlights?.en || []).join('\n'))}</textarea>
              </div>
              <div class="form-field">
                <label>${t('متطلبات التشغيل (المعالج / الرام / كرت الشاشة / المساحة)', 'System Requirements')}</label>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                  <input class="brutal-input" name="req_cpu" value="${esc(item.requirements?.cpu)}" placeholder="CPU" />
                  <input class="brutal-input" name="req_ram" value="${esc(item.requirements?.ram)}" placeholder="RAM (4 GB)" />
                  <input class="brutal-input" name="req_gpu" value="${esc(item.requirements?.gpu)}" placeholder="GPU" />
                  <input class="brutal-input" name="req_disk" value="${esc(item.requirements?.disk)}" placeholder="Disk (500 MB)" />
                </div>
                <input type="hidden" name="req_os_ar" value="${esc(item.requirements?.os?.ar || 'Windows • Linux • macOS • Android • iOS')}" />
                <input type="hidden" name="req_arch" value="${esc(item.requirements?.arch || 'x64 / ARM64')}" />
                <input type="hidden" name="techStack" value="${esc(item.techStack || '')}" />
                <input type="hidden" name="tags_ar" value="${esc((item.tags?.ar || []).join(', '))}" />
                <input type="hidden" name="tags_en" value="${esc((item.tags?.en || []).join(', '))}" />
              </div>
              <div class="form-field full">
                <label style="display:flex;align-items:center;gap:8px;">
                  <input type="checkbox" name="opt_demo_on" ${item.optionalDemo?.enabled ? 'checked' : ''} />
                  ${t('إظهار زر رابط معاينة خارجي اختياري', 'Enable Optional External Demo Link')}
                </label>
                <input class="brutal-input" name="opt_demo_url" value="${esc(item.optionalDemo?.url)}" placeholder="https://..." />
              </div>
            </div>
          </details>
        </div>

        <!-- STEP 2: VISUAL MEDIA STUDIO (COVER IMAGE + MULTI SCREENSHOTS + DIRECT VIDEO UPLOAD!) -->
        <div class="cp-card">
          <div class="cp-card-title">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="pub-step-badge">2</span>
              <span>🖼️ ${t('استوديو الصور والفيديو الاستعراضي (ارفع الغلاف، لقطات الشاشة، وملف الفيديو مباشرة!)', 'Step 2: Cover Image, Screenshots Gallery & Direct Video File Upload')}</span>
            </div>
          </div>

          <div class="media-studio-grid">
            <!-- 2A. COVER IMAGE -->
            <div class="media-box">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <strong>🖼️ ${t('صورة الغلاف الرئيسية', 'Main Cover Image')}</strong>
              </div>
              <div style="aspect-ratio:16/10;border-radius:10px;overflow:hidden;border:1px solid var(--border-base);background:#000;">
                <img id="liveCoverPreview" src="${esc(item.cover)}" alt="Cover" style="width:100%;height:100%;object-fit:cover;display:block;" />
              </div>
              <label class="upload-action-btn">
                📤 ${t('اختر صورة غلاف من جهازك', 'Upload Cover Image')}
                <input type="file" id="cpCoverUpload" accept="image/*" style="display:none;" />
              </label>
              <input class="brutal-input mono" style="font-size:0.78rem;" name="cover" id="cpCoverInp" value="${esc(item.cover)}" placeholder="/assets/covers/..." />
            </div>

            <!-- 2B. DIRECT VIDEO FILE UPLOADER + PLAYER PREVIEW -->
            <div class="media-box">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <strong>🎬 ${t('فيديو استعراض اللعبة / التطبيق (Trailer)', 'Gameplay / App Video Trailer')}</strong>
                ${item.trailerUrl ? `<button type="button" class="brutal-btn signal" style="padding:4px 10px;font-size:0.76rem;" id="clearVideoBtn">🗑️ ${t('حذف الفيديو', 'Remove')}</button>` : ''}
              </div>

              <div id="liveVideoPreviewWrap" style="aspect-ratio:16/10;border-radius:10px;overflow:hidden;border:1px solid var(--border-base);background:#07090E;display:grid;place-items:center;">
                ${item.trailerUrl ? (
                  isYtVideo
                    ? `<div style="padding:14px;text-align:center;font-size:0.85rem;color:var(--accent-emerald);">▶️ ${t('تم ربط فيديو يوتيوب بنجاح:', 'YouTube Video Linked:')}<div class="mono" style="font-size:0.74rem;margin-top:6px;word-break:break-all;">${esc(item.trailerUrl)}</div></div>`
                    : `<video src="${esc(item.trailerUrl)}" controls playsinline preload="metadata" style="width:100%;height:100%;object-fit:contain;background:#000;"></video>`
                ) : `
                  <div style="text-align:center;color:var(--text-muted);padding:16px;font-size:0.84rem;">
                    <div style="font-size:2rem;margin-bottom:6px;">🎬</div>
                    ${t('لا يوجد فيديو مرفوع بعد — اضغط زر رفع ملف الفيديو بالأسفل (.MP4 / .WebM / .MOV) أو الصق رابط يوتيوب', 'Upload an MP4/WebM/MOV video file or paste a YouTube URL below')}
                  </div>
                `}
              </div>

              <label class="upload-action-btn video-btn">
                🎬 ${t('زر رفع ملف فيديو من جهازك (.MP4 / .WebM / .MOV)', 'Upload Video File (.MP4 / .WebM / .MOV)')}
                <input type="file" id="cpVideoFileUpload" accept="video/mp4,video/webm,video/quicktime,video/x-matroska,video/ogg,video/x-msvideo,.mp4,.webm,.mov,.m4v,.mkv,.ogg,.avi" style="display:none;" />
              </label>

              <input class="brutal-input mono" style="font-size:0.78rem;" name="trailerUrl" id="cpTrailerUrlInp" value="${esc(item.trailerUrl || '')}"
                     placeholder="${t('أو الصق رابط فيديو خارجي / YouTube هنا...', 'Or paste YouTube / direct MP4 link here...')}" />
            </div>
          </div>

          <!-- 2C. MULTI-SCREENSHOTS GALLERY -->
          <div class="media-box" style="margin-top:18px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
              <div>
                <strong>📸 ${t(`معرض صور ولقطات الشاشة من داخل التطبيق أو اللعبة (${(item.screenshots || []).length} صور)`, `In-App / Gameplay Screenshots Gallery (${(item.screenshots || []).length})`)}</strong>
                <div style="font-size:0.8rem;color:var(--text-muted);">${t('يمكنك تحديد عدة صور معاً من جهازك ورفعها دفعة واحدة!', 'You can select & upload multiple screenshots at once!')}</div>
              </div>
              <label class="upload-action-btn emerald-btn">
                📸 ${t('+ رفع صور ولقطات شاشة متعددة', '+ Upload Screenshots (Multiple)')}
                <input type="file" id="cpMultiShotsInp" accept="image/*" multiple style="display:none;" />
              </label>
            </div>

            ${(item.screenshots || []).length > 0 ? `
              <div class="shot-gallery-grid">
                ${(item.screenshots || []).map((s, i) => `
                  <div class="shot-card-item">
                    <img src="${esc(s)}" alt="Screenshot ${i + 1}" />
                    <button type="button" class="shot-del-btn" data-rm-shot="${i}" title="${t('حذف الصورة', 'Remove')}">✕</button>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div style="padding:18px;text-align:center;color:var(--text-muted);font-size:0.85rem;background:var(--bg-input);border-radius:10px;">
                ${t('لم تقم بإضافة لقطات شاشة إضافية بعد — اضغط "+ رفع صور ولقطات شاشة متعددة" لإضافتها.', 'No extra screenshots added yet.')}
              </div>
            `}

            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <input class="brutal-input mono" style="flex:1;min-width:220px;font-size:0.8rem;" id="shotExternalUrlInp"
                     placeholder="${t('أو الصق رابط صورة خارجي واضغط إضافة...', 'Or paste an external image URL...')}" />
              <button type="button" class="brutal-btn" id="addExternalShotBtn">+ ${t('إضافة رابط صورة', 'Add Image URL')}</button>
            </div>
          </div>
        </div>

        <!-- STEP 3: DIRECT PLATFORM INSTALLERS & DOWNLOAD LINKS -->
        <div class="cp-card">
          <div class="cp-card-title">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="pub-step-badge">3</span>
              <span>🚀 ${t('ملفات التثبيت والتحميل للأنظمة (ارفع ملف اللعبة/التطبيق مباشرة أو ضع رابط تحميل)', 'Step 3: Upload Installers (.EXE / .APK / .DEB / .AppImage / .DMG / .IPA) or Links')}</span>
            </div>
          </div>
          <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:16px;">
            ${t(
              'ارفع ملف التثبيت أو ضع رابط التحميل للنظام المتوفر لديك فقط (مثل Windows أو Android) وسيتم تفعيله وحساب حجمه وبصمته الرقمية SHA-256 تلقائياً!',
              'Simply upload an installer or paste a download URL for any OS you support — size & SHA-256 checksum are computed automatically!'
            )}
          </p>

          <div class="matrix-grid">
            ${ALL_PLATFORMS.map(pk => {
              const p = item.platforms?.[pk] || { available: false, size: '—', format: pk.toUpperCase(), externalUrl: '', sha256: '' };
              return `
                <div class="plat-card ${p.available ? 'recommended' : ''}" style="padding:16px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <span style="display:flex;align-items:center;gap:8px;font-weight:800;">
                      ${ICONS[pk]} ${esc(PLAT_LABELS[cp.lang][pk])}
                    </span>
                    <label style="display:flex;align-items:center;gap:5px;font-size:0.8rem;cursor:pointer;">
                      <input type="checkbox" data-ptoggle="${pk}" ${p.available ? 'checked' : ''} />
                      ${p.available ? `✅ ${t('مفعّل', 'Active')}` : t('غير مفعّل', 'Off')}
                    </label>
                  </div>

                  <label class="upload-action-btn" style="padding:9px 12px;font-size:0.82rem;margin-top:4px;">
                    ⬆️ ${t(`رفع ملف ${pk.toUpperCase()} من جهازك`, `Upload ${pk.toUpperCase()} Binary`)}
                    <input type="file" data-pupload="${pk}" style="display:none;" />
                  </label>

                  ${p.fileName ? `
                    <div class="mono" style="font-size:0.74rem;color:var(--accent-emerald);background:var(--bg-input);padding:6px 9px;border-radius:8px;">
                      📦 ${esc(p.fileName)} (${esc(p.size || '')})
                    </div>
                  ` : ''}

                  <input class="brutal-input mono" style="font-size:0.78rem;" id="pExt_${pk}" value="${esc(p.externalUrl || '')}"
                         placeholder="${t('أو رابط خارجي مباشر (Drive / GitHub / CDN)...', 'Or external direct download URL...')}" />

                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                    <input class="brutal-input mono" style="font-size:0.76rem;" id="pSize_${pk}" value="${esc(p.size || '')}" placeholder="${t('الحجم (مثال 85 MB)', 'Size')}" />
                    <input class="brutal-input mono" style="font-size:0.76rem;" id="pFmt_${pk}" value="${esc(p.format || pk.toUpperCase())}" placeholder="EXE / APK / ZIP" />
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <!-- EXTRA MIRRORS -->
          <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border-base);">
            <strong style="display:block;margin-bottom:10px;font-size:0.9rem;">🔗 ${t('روابط إضافية اختيارية (نسخة محمولة Portable / سورس كود / تورنت)', 'Optional Extra Mirrors')}</strong>
            <div style="display:grid;gap:8px;margin-bottom:10px;">
              ${(item.extraLinks || []).map((ex, idx) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-panel-alt);border-radius:10px;border:1px solid var(--border-base);">
                  <span><strong>${esc(ex.label)}</strong> (${esc(ex.size || '—')}) — <span class="mono" style="font-size:0.76rem;">${esc(ex.url)}</span></span>
                  <button type="button" class="brutal-btn signal" style="padding:4px 10px;" data-rm-extra="${idx}">✕</button>
                </div>
              `).join('')}
            </div>
            <div style="display:grid;grid-template-columns:1.2fr 0.7fr 2fr auto;gap:8px;">
              <input class="brutal-input" id="newExLabel" placeholder="${t('اسم الرابط (نسخة محمولة)', 'Mirror Label')}" />
              <input class="brutal-input mono" id="newExSize" placeholder="45 MB" />
              <input class="brutal-input mono" id="newExUrl" placeholder="https://..." />
              <button type="button" class="brutal-btn" id="addExtraLinkBtn">+ ${t('إضافة', 'Add')}</button>
            </div>
          </div>
        </div>

        <!-- BOTTOM SUBMIT BAR -->
        <div style="display:flex;justify-content:flex-end;gap:12px;">
          <button type="submit" class="brutal-btn volt" style="padding:14px 32px;font-size:1rem;">
            🚀 ${t('حفظ ونشر التطبيق / اللعبة في المتجر الآن', 'Save & Publish to Storefront Now')}
          </button>
        </div>
      </form>
    `;

    // Wire markdown toolbar
    box.querySelectorAll('[data-md]').forEach(b => {
      b.onclick = () => insertMdTag(document.getElementById('descArArea'), b.dataset.md, b.dataset.mds || '');
    });

    document.getElementById('backAppsListBtn').onclick = () => {
      cp.editingAppSlug = null;
      cp.draftApp = null;
      render();
    };

    // 1. Cover Upload
    document.getElementById('cpCoverUpload').onchange = async e => {
      const f = e.target.files?.[0];
      if (!f) return;
      syncFormIntoDraft();
      const fd = new FormData();
      fd.append('slug', item.slug || item.title?.ar || 'cover');
      fd.append('file', f);
      const d = await uploadWithProgress('/api/admin/upload/media', fd, (p, l) => setProgress(true, p, `🖼️ ${l}`));
      setProgress(false);
      if (d.ok) {
        item.cover = d.mediaUrl;
        document.getElementById('cpCoverInp').value = d.mediaUrl;
        document.getElementById('liveCoverPreview').src = d.mediaUrl;
        toast(t('تم رفع صورة الغلاف بنجاح!', 'Cover image uploaded!'));
      }
    };

    document.getElementById('cpCoverInp').oninput = e => {
      const v = e.target.value.trim();
      if (v) document.getElementById('liveCoverPreview').src = v;
    };

    // 2. Direct Video File Upload (.MP4 / .WebM / .MOV) + Live Preview!
    document.getElementById('cpVideoFileUpload').onchange = async e => {
      const f = e.target.files?.[0];
      if (!f) return;
      syncFormIntoDraft();
      const fd = new FormData();
      fd.append('slug', `${item.slug || item.title?.ar || 'trailer'}-video`);
      fd.append('file', f);
      const d = await uploadWithProgress('/api/admin/upload/media', fd, (p, l) => setProgress(true, p, `🎬 جاري رفع الفيديو: ${l}`));
      setProgress(false);
      if (d.ok) {
        item.trailerUrl = d.mediaUrl;
        toast(t(`تم رفع ملف الفيديو بنجاح (${d.sizeFormatted || ''})!`, 'Video trailer uploaded!'));
        render();
      } else {
        toast(t('صيغة الفيديو غير مدعومة — استخدم MP4 أو WebM أو MOV', 'Unsupported video format'));
      }
    };

    document.getElementById('cpTrailerUrlInp').onchange = e => {
      syncFormIntoDraft();
      item.trailerUrl = e.target.value.trim();
      render();
    };

    document.getElementById('clearVideoBtn')?.addEventListener('click', () => {
      syncFormIntoDraft();
      item.trailerUrl = '';
      render();
    });

    // 3. Multi-Screenshots Upload
    document.getElementById('cpMultiShotsInp').onchange = async e => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      syncFormIntoDraft();
      for (let i = 0; i < files.length; i++) {
        const fd = new FormData();
        fd.append('slug', `${item.slug || item.title?.ar || 'shot'}-${i + 1}`);
        fd.append('file', files[i]);
        const d = await uploadWithProgress('/api/admin/upload/media', fd, (p, l) =>
          setProgress(true, p, `📸 صورة (${i + 1}/${files.length}): ${l}`)
        );
        if (d.ok) {
          item.screenshots = [...(item.screenshots || []), d.mediaUrl];
        }
      }
      setProgress(false);
      toast(t(`تم رفع ${files.length} صور لمعرض اللقطات!`, `Uploaded ${files.length} screenshots!`));
      render();
    };

    document.getElementById('addExternalShotBtn').onclick = () => {
      const u = document.getElementById('shotExternalUrlInp').value.trim();
      if (!u) return;
      syncFormIntoDraft();
      item.screenshots = [...(item.screenshots || []), u];
      render();
    };

    box.querySelectorAll('[data-rm-shot]').forEach(btn => {
      btn.onclick = () => {
        syncFormIntoDraft();
        const idx = Number(btn.dataset.rmShot);
        item.screenshots.splice(idx, 1);
        render();
      };
    });

    // 4. Direct Platform Binary Upload (Auto-saves draft first if brand new!)
    box.querySelectorAll('[data-pupload]').forEach(inp => {
      inp.onchange = async e => {
        const f = e.target.files?.[0];
        const pk = inp.dataset.pupload;
        if (!f) return;
        try {
          const saved = await ensureSavedOnServer();
          const fd = new FormData();
          fd.append('file', f);
          const d = await uploadWithProgress(
            `/api/admin/upload/release/${encodeURIComponent(saved.slug)}/${pk}`,
            fd,
            (p, l) => setProgress(true, p, `📦 ${pk.toUpperCase()}: ${l}`)
          );
          setProgress(false);
          if (d.ok) {
            await refreshState();
            cp.draftApp = JSON.parse(JSON.stringify(cp.data.catalog.find(x => x.slug === saved.slug)));
            toast(t(`تم رفع حزمة ${pk.toUpperCase()} وحساب البصمة الرقمية تلقائياً!`, `${pk.toUpperCase()} package uploaded!`));
            render();
          }
        } catch (_) {
          setProgress(false);
          toast(t('اكتب اسم التطبيق أولاً ثم ارفع الملف', 'Please enter an app title first'));
        }
      };
    });

    // Extra links
    document.getElementById('addExtraLinkBtn').onclick = () => {
      const label = document.getElementById('newExLabel').value.trim();
      const size = document.getElementById('newExSize').value.trim();
      const url = document.getElementById('newExUrl').value.trim();
      if (!label || !url) return;
      syncFormIntoDraft();
      item.extraLinks = [...(item.extraLinks || []), { label, size, url }];
      render();
    };

    box.querySelectorAll('[data-rm-extra]').forEach(btn => {
      btn.onclick = () => {
        syncFormIntoDraft();
        item.extraLinks.splice(Number(btn.dataset.rmExtra), 1);
        render();
      };
    });

    // 5. Final Save & Publish
    document.getElementById('cpAppForm').onsubmit = async e => {
      e.preventDefault();
      syncFormIntoDraft();
      const res = await api('/api/admin/catalog', { method: 'POST', body: JSON.stringify(item) });
      if (res.ok) {
        await refreshState();
        cp.editingAppSlug = res.item.slug;
        cp.draftApp = JSON.parse(JSON.stringify(res.item));
        toast(t('✅ تم حفظ ونشر التطبيق / اللعبة في المتجر بنجاح!', '✅ Saved & published to Storefront!'));
        render();
      }
    };

    document.getElementById('cpDelAppBtn')?.addEventListener('click', async () => {
      if (!confirm(t('هل تريد حذف هذا التطبيق نهائياً؟', 'Delete permanently?'))) return;
      await api(`/api/admin/catalog/${encodeURIComponent(item.slug)}`, { method: 'DELETE' });
      await refreshState();
      cp.editingAppSlug = null;
      cp.draftApp = null;
      render();
    });

    return;
  }

  // Apps Table List
  box.innerHTML = `
    <div class="cp-card">
      <div class="cp-card-title">
        <span>📦 ${t('جميع التطبيقات والأدوات والألعاب', 'All Published & Draft Software')} (${cp.data.catalog.length})</span>
        <button type="button" class="brutal-btn volt" id="cpNewAppBtn">+ ${t('نشر تطبيق أو لعبة جديدة', 'Publish New App / Game')}</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="cp-table">
          <thead>
            <tr>
              <th>${t('الغلاف', 'Cover')}</th>
              <th>${t('الاسم', 'Title')}</th>
              <th>${t('القسم', 'Category')}</th>
              <th>${t('الإصدار والحالة', 'Version & Status')}</th>
              <th>${t('ميديا', 'Media')}</th>
              <th>${t('المنصات المفعلة', 'Active OS')}</th>
              <th>${t('التحميلات', 'Downloads')}</th>
              <th>${t('إجراءات', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${cp.data.catalog.map(it => {
              const activeOs = ALL_PLATFORMS.filter(p => it.platforms?.[p]?.available);
              return `
                <tr>
                  <td><img src="${esc(it.cover)}" alt="" style="width:54px;height:36px;object-fit:cover;border-radius:6px;" /></td>
                  <td><strong>${esc(pickText(it.title, cp.lang))}</strong></td>
                  <td>${esc(it.category)}</td>
                  <td>
                    <span class="mono">${esc(it.version)}</span>
                    ${it.status === 'draft' ? `<span class="tag-pill">Draft</span>` : `<span class="channel-badge">${esc(it.channel || 'stable')}</span>`}
                  </td>
                  <td style="font-size:0.8rem;">
                    📸 ${(it.screenshots || []).length}
                    ${it.trailerUrl ? ' • 🎬 فيديو' : ''}
                  </td>
                  <td>${activeOs.map(p => ICONS[p]).join(' ')} (${activeOs.length}/6)</td>
                  <td class="mono">${(it.stats?.totalDownloads || 0).toLocaleString()}</td>
                  <td>
                    <button type="button" class="brutal-btn" style="padding:5px 10px;" data-edit-app="${esc(it.slug)}">✎ ${t('تحرير / ميديا / حزم', 'Edit & Media')}</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('cpNewAppBtn').onclick = () => {
    cp.editingAppSlug = '__NEW__';
    cp.draftApp = null;
    render();
  };
  box.querySelectorAll('[data-edit-app]').forEach(btn => {
    btn.onclick = () => {
      cp.editingAppSlug = btn.dataset.editApp;
      cp.draftApp = null;
      render();
    };
  });
}

// ================= 2B. MULTI-THEME VISUAL SKIN SWITCHER (6 DISTINCT SITE SKINS!) =================

function renderThemesTab(box) {
  const cfg = cp.data.siteConfig || {};
  const activeSkin = cfg.siteTheme || 'modern_glass';
  const defaultMode = cfg.defaultTheme || 'dark';
  const showTicker = Boolean(cfg.showTicker);
  const tickerAr = (cfg.ticker?.ar || []).join('\n');
  const tickerEn = (cfg.ticker?.en || []).join('\n');

  const SKINS = [
    {
      id: 'modern_glass',
      badge: '✨ 2026 Default',
      ar: 'العصري الزجاجي الأنيق (Modern Glass 2026)',
      en: 'Modern Glass 2026 (Default)',
      descAr: 'تصميم زجاجي ناعم بزوايا دائرية مريحة وتدرجات نيلي وبنفسجي عصرية هادئة.',
      descEn: 'Sleek glassmorphic bento cards, smooth corners, and Indigo-Violet gradients.',
      bg: '#090D16', panel: '#111827', border: 'rgba(255,255,255,0.14)', radius: '16px', shadow: 'none',
      btnBg: 'linear-gradient(135deg,#6366F1,#8B5CF6)', btnInk: '#FFFFFF'
    },
    {
      id: 'neo_brutalist',
      badge: '⚡ الثيم الماضي المتوحش!',
      ar: 'الثيم المتوحش الصارخ (Hardcore Neo-Brutalist)',
      en: 'Hardcore Neo-Brutalist (Classic Brutal)',
      descAr: 'الثيم الماضي المتوحش بالكامل! زوايا حادة 0px، حدود سميكة صلبة، ظلال سوداء قاسية، أصفر فولت ناري #D4FF00 وبرتقالي صارخ #FF3B00 مع خلفية هندسية وشريط أخبار متحرك!',
      descEn: '0px sharp corners, 2.5px thick borders, hard offset shadows, Acid Volt #D4FF00 & Signal Orange #FF3B00!',
      bg: '#08080A', panel: '#14141B', border: '#D4FF00', radius: '0px', shadow: '5px 5px 0px #FF3B00',
      btnBg: '#D4FF00', btnInk: '#08080A', suggestTicker: true
    },
    {
      id: 'cyber_matrix',
      badge: '💻 Cyberpunk',
      ar: 'السايبر بانك والهاكرز (Cyber Matrix Neon)',
      en: 'Cyber Matrix Neon',
      descAr: 'أجواء تيرمينال وسايبر بانك متوهجة باللون السماوي النيون #00F0FF وأخضر الماتريكس #00FF9C.',
      descEn: 'Glowing Cyan #00F0FF & Matrix Emerald #00FF9C neon terminal aesthetic.',
      bg: '#04090E', panel: '#091520', border: '#00F0FF', radius: '6px', shadow: '0 0 16px rgba(0,240,255,0.35)',
      btnBg: 'linear-gradient(135deg,#00F0FF,#00FF9C)', btnInk: '#021014'
    },
    {
      id: 'gamer_arena',
      badge: '🎮 Gaming Store',
      ar: 'ساحة الألعاب النارية (Gamer Arena Crimson)',
      en: 'Gamer Arena Crimson',
      descAr: 'مصمم خصيصاً لمتاجر الألعاب القوية بتدرجات القرمزي الناري والماجنتا بأسلوب ROG و Steam.',
      descEn: 'High-energy Crimson & Magenta gaming storefront vibe.',
      bg: '#0B070E', panel: '#181022', border: '#F43F5E', radius: '14px', shadow: '0 10px 22px rgba(244,63,94,0.28)',
      btnBg: 'linear-gradient(135deg,#F43F5E,#DB2777)', btnInk: '#FFFFFF'
    },
    {
      id: 'royal_gold',
      badge: '👑 Luxury Edition',
      ar: 'الفخامة الذهبية الملكية (Royal Obsidian Gold)',
      en: 'Royal Obsidian Gold',
      descAr: 'مظهر ملكي فاخر يجمع بين الأسود المخملي وتدرجات الذهب الدافئة لإبراز البرامج الحصرية.',
      descEn: 'Velvet onyx surfaces paired with warm Champagne & Royal Gold accents.',
      bg: '#0B0A08', panel: '#181510', border: '#F59E0B', radius: '16px', shadow: 'none',
      btnBg: 'linear-gradient(135deg,#FBBF24,#D97706)', btnInk: '#1C1102'
    },
    {
      id: 'emerald_forest',
      badge: '🌿 Calm Emerald',
      ar: 'الزمرد الهادئ (Nordic Emerald & Teal)',
      en: 'Nordic Emerald & Teal',
      descAr: 'مظهر تقني نظيف ومريح جداً للعين بدرجات الأخضر الزمردي والتيل الهادئ.',
      descEn: 'Clean, ultra-calm Nordic Emerald & Teal developer palette.',
      bg: '#06100E', panel: '#0E201C', border: '#10B981', radius: '16px', shadow: 'none',
      btnBg: 'linear-gradient(135deg,#34D399,#0D9488)', btnInk: '#022C22'
    }
  ];

  box.innerHTML = `
    <div style="display:grid;gap:22px;">
      <!-- QUICK SITE ICON / LOGO & BRAND NAME STUDIO -->
      <div class="cp-card">
        <div class="cp-card-title">
          <span>🖼️ ${t('أيقونة ولوجو الموقع + اسم المنصة (ارفع الأيقونة بضغطة واحدة!)', 'Site Logo, Favicon & Brand Name')}</span>
          <a href="/" target="_blank" class="brutal-btn volt">🌐 ${t('معاينة المتجر الحي ↗', 'Open Storefront ↗')}</a>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;align-items:center;">
          <div class="media-box" style="align-items:center;text-align:center;">
            <div style="height:88px;display:flex;align-items:center;justify-content:center;">
              ${cfg.logoUrl
                ? `<img src="${esc(cfg.logoUrl)}" alt="Site Logo" style="max-height:84px;max-width:220px;border-radius:14px;object-fit:contain;" />`
                : `<div class="brand-mark" style="width:64px;height:64px;font-size:1.6rem;">${esc((cfg.brandCode || 'Ø').slice(0, 2))}</div>`}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;width:100%;">
              <label class="upload-action-btn" style="flex:1;">
                📤 ${t('رفع أيقونة / لوجو الموقع', 'Upload Site Icon / Logo')}
                <input type="file" id="quickThemeLogoInp" accept="image/*" style="display:none;" />
              </label>
              ${cfg.logoUrl ? `<button type="button" class="brutal-btn signal" id="clearSiteLogoBtn">🗑️ ${t('إزالة', 'Remove')}</button>` : ''}
            </div>
            <label style="display:flex;align-items:center;gap:8px;font-size:0.8rem;cursor:pointer;">
              <input type="checkbox" id="quickHideBrandTextChk" ${cfg.hideBrandText ? 'checked' : ''} />
              <span>${t('إخفاء النص الجانبي (إذا كان اللوجو مرسوماً بداخله الاسم)', 'Hide text next to logo (if logo already contains name)')}</span>
            </label>
          </div>

          <form id="quickNameForm" style="display:grid;gap:12px;">
            <div class="form-field">
              <label>${t('اسم الموقع بالعربية', 'Website Name (Arabic)')}</label>
              <input class="brutal-input" name="q_title_ar" value="${esc(cfg.title?.ar || '')}" placeholder="مثال: بايت توبيا" />
            </div>
            <div class="form-field">
              <label>${t('اسم الموقع بالإنجليزية', 'Website Name (English)')}</label>
              <input class="brutal-input" name="q_title_en" value="${esc(cfg.title?.en || '')}" placeholder="e.g. ByteTopia" />
            </div>
            <div class="form-field">
              <label>${t('جملة التعريف بجانب الأيقونة (عربي)', 'Tagline next to the icon (Arabic)')}</label>
              <input class="brutal-input" name="q_tagline_ar" value="${esc(cfg.headerTagline?.ar || '')}"
                     placeholder="${t('مثال: تطبيقات أصلية موثّقة لكل الأنظمة', 'e.g. Verified apps for every platform')}" maxlength="120" />
            </div>
            <div class="form-field">
              <label>${t('جملة التعريف بجانب الأيقونة (إنجليزي)', 'Tagline next to the icon (English)')}</label>
              <input class="brutal-input" name="q_tagline_en" value="${esc(cfg.headerTagline?.en || '')}"
                     placeholder="e.g. Verified apps for every platform" maxlength="120" />
            </div>
            <button type="submit" class="brutal-btn volt">💾 ${t('حفظ الاسم والجملة', 'Save Name & Tagline')}</button>
          </form>
        </div>
      </div>

      <div class="cp-card">
        <div class="cp-card-title">
          <span>⚖️ ${t('نص الحقوق وكلام الفوتر', 'Footer Rights & Text')}</span>
        </div>
        <form id="footerTextForm" style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
          <div class="form-field">
            <label>${t('سطر الحقوق (عربي)', 'Rights line (Arabic)')}</label>
            <input class="brutal-input" name="f_rights_ar" value="${esc(cfg.footerRights?.ar || '')}"
                   placeholder="جميع الحقوق محفوظة" maxlength="160" />
          </div>
          <div class="form-field">
            <label>${t('سطر الحقوق (إنجليزي)', 'Rights line (English)')}</label>
            <input class="brutal-input" name="f_rights_en" value="${esc(cfg.footerRights?.en || '')}"
                   placeholder="All rights reserved" maxlength="160" />
          </div>
          <div class="form-field">
            <label>${t('جملة إضافية في الفوتر (عربي)', 'Extra footer note (Arabic)')}</label>
            <input class="brutal-input" name="f_note_ar" value="${esc(cfg.footerNote?.ar || '')}"
                   placeholder="${t('اتركه فاضي لإخفائها', 'Leave empty to hide')}" maxlength="160" />
          </div>
          <div class="form-field">
            <label>${t('جملة إضافية في الفوتر (إنجليزي)', 'Extra footer note (English)')}</label>
            <input class="brutal-input" name="f_note_en" value="${esc(cfg.footerNote?.en || '')}"
                   placeholder="Leave empty to hide" maxlength="160" />
          </div>
          <div class="form-field" style="grid-column:1/-1;">
            <label>${t('السنة', 'Year')}</label>
            <select class="brutal-input" name="f_year_mode">
              <option value="auto" ${cfg.footerYear === 0 ? '' : 'selected'}>${t('السنة الحالية تلقائياً', 'Current year automatically')}</option>
              <option value="none" ${cfg.footerYear === 0 ? 'selected' : ''}>${t('بدون سنة', 'No year')}</option>
            </select>
          </div>
          <div class="form-field" style="grid-column:1/-1;">
            <p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 8px;">
              ${t('يمكنك استخدام {year} للسنة و {name} لاسم الموقع داخل أي جملة.', 'You can use {year} for the year and {name} for the site name inside any sentence.')}
            </p>
            <button type="submit" class="brutal-btn volt">💾 ${t('حفظ كلام الفوتر', 'Save footer text')}</button>
          </div>
        </form>
      </div>

      <div class="cp-card">
        <div class="cp-card-title">
          <span>🎨 ${t('مكتبة ثيمات ومظهر الموقع — غيّر شكل المتجر بالكامل بضغطة زر!', 'Storefront Theme Switcher — Change Your Entire Website Look in 1 Click!')}</span>
        </div>
        <p style="font-size:0.88rem;color:var(--text-muted);margin-bottom:18px;">
          ${t(
            'اختر أي ثيم لتطبيقه فوراً على جميع زوار الموقع (مع دعم كامل للوضعين الليلي الداكن والنهاري الفاتح في كل ثيم!). يتضمن ذلك الثيم الزجاجي الحديث وكذلك الثيم الماضي المتوحش (Neo-Brutalist) و4 ثيمات إضافية مميزة.',
            'Select any visual theme below to apply it immediately across your entire storefront for all visitors (every theme supports both Dark & Light modes).'
          )}
        </p>

        <div class="theme-skin-grid">
          ${SKINS.map(sk => {
            const isCurrent = activeSkin === sk.id;
            return `
              <div class="theme-skin-card ${isCurrent ? 'active-skin' : ''}">
                <div style="display:flex;flex-direction:column;gap:12px;">
                  <div class="skin-mockup" style="background:${sk.bg};border:2px solid ${sk.border};border-radius:${sk.radius};box-shadow:${sk.shadow};">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                      <span style="background:${sk.panel};color:#FFF;padding:3px 9px;font-size:0.7rem;font-weight:800;border:1px solid ${sk.border};border-radius:${sk.radius};">${esc(sk.badge)}</span>
                      <span style="width:10px;height:10px;border-radius:50%;background:${sk.border};display:inline-block;"></span>
                    </div>
                    <div style="display:flex;justify-content:space-between;align-items:center;background:${sk.panel};padding:8px 10px;border:1px solid ${sk.border};border-radius:${sk.radius};">
                      <span style="color:#F8FAFC;font-size:0.76rem;font-weight:800;">ODDWARE STORE</span>
                      <span style="background:${sk.btnBg};color:${sk.btnInk};padding:4px 10px;font-size:0.72rem;font-weight:900;border-radius:${sk.radius};">⬇ تحميل</span>
                    </div>
                  </div>

                  <div>
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                      <strong style="font-size:0.98rem;">${esc(cp.lang === 'ar' ? sk.ar : sk.en)}</strong>
                    </div>
                    <p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px;line-height:1.6;">
                      ${esc(cp.lang === 'ar' ? sk.descAr : sk.descEn)}
                    </p>
                  </div>
                </div>

                <button type="button"
                        class="brutal-btn ${isCurrent ? '' : 'volt'}"
                        style="width:100%;${isCurrent ? 'border-color:var(--accent-emerald);color:var(--accent-emerald);' : ''}"
                        data-apply-skin="${esc(sk.id)}">
                  ${isCurrent
                    ? `✅ ${t('الثيم المفعّل حالياً على الموقع', 'Currently Active Theme')}`
                    : `✨ ${t('تفعيل هذا الثيم فوراً', 'Activate This Theme')}`}
                </button>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="cp-card">
        <div class="cp-card-title">
          <span>⚡ ${t('خيارات الإضاءة الافتراضية وشريط الأخبار المتحرك (Ticker)', 'Default Light/Dark Mode & Top Scrolling Ticker Bar')}</span>
        </div>

        <form id="cpThemeExtrasForm" class="form-grid">
          <div class="form-field">
            <label>${t('الوضع اللوني الافتراضي للزائر الجديد', 'Default Color Mode for New Visitors')}</label>
            <select class="brutal-select" name="defaultTheme">
              <option value="dark" ${defaultMode !== 'light' ? 'selected' : ''}>🌙 ${t('الوضع الليلي الداكن (Dark Mode)', 'Dark Mode')}</option>
              <option value="light" ${defaultMode === 'light' ? 'selected' : ''}>☀️ ${t('الوضع النهاري الفاتح (Light Mode)', 'Light Mode')}</option>
            </select>
          </div>

          <div class="form-field" style="display:flex;flex-direction:column;justify-content:center;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:800;margin-top:18px;">
              <input type="checkbox" name="showTicker" ${showTicker ? 'checked' : ''} style="width:18px;height:18px;" />
              <span>⚡ ${t('إظهار شريط الأخبار المتحرك أعلى المتجر (رائع جداً مع الثيم المتوحش!)', 'Show Top Scrolling Marquee Ticker Bar')}</span>
            </label>
          </div>

          <div class="form-field">
            <label>${t('عبارات الشريط المتحرك بالعربية (عبارة في كل سطر)', 'Arabic Ticker Lines (One per line)')}</label>
            <textarea class="brutal-input" style="min-height:84px;" name="ticker_ar">${esc(tickerAr)}</textarea>
          </div>

          <div class="form-field">
            <label>English Ticker Lines (One per line)</label>
            <textarea class="brutal-input" style="min-height:84px;" name="ticker_en">${esc(tickerEn)}</textarea>
          </div>

          <div class="form-field full">
            <button type="submit" class="brutal-btn volt">💾 ${t('حفظ خيارات الإضاءة والشريط المتحرك', 'Save Mode & Ticker Settings')}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('quickThemeLogoInp')?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('slug', 'site-logo');
    fd.append('file', f);
    const d = await uploadWithProgress('/api/admin/upload/media', fd, (p, l) => setProgress(true, p, `🖼️ ${l}`));
    setProgress(false);
    if (d.ok) {
      await api('/api/admin/site-config', { method: 'PUT', body: JSON.stringify({ logoUrl: d.mediaUrl }) });
      await refreshState();
      toast(t('✅ تم رفع وتفعيل أيقونة / لوجو الموقع فوراً!', '✅ Site icon/logo uploaded & activated!'));
      render();
    }
  });

  document.getElementById('clearSiteLogoBtn')?.addEventListener('click', async () => {
    await api('/api/admin/site-config', { method: 'PUT', body: JSON.stringify({ logoUrl: '', hideBrandText: false }) });
    await refreshState();
    toast(t('تمت إزالة اللوجو المخصص', 'Removed custom logo'));
    render();
  });

  document.getElementById('quickHideBrandTextChk')?.addEventListener('change', async e => {
    await api('/api/admin/site-config', { method: 'PUT', body: JSON.stringify({ hideBrandText: e.target.checked }) });
    await refreshState();
    toast(t('تم تحديث طريقة عرض اللوجو', 'Updated logo text visibility'));
    render();
  });

  document.getElementById('quickNameForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const arName = (fd.get('q_title_ar') || '').trim();
    const enName = (fd.get('q_title_en') || '').trim() || arName;
    const tagAr = (fd.get('q_tagline_ar') || '').trim();
    const tagEn = (fd.get('q_tagline_en') || '').trim() || tagAr;
    await api('/api/admin/site-config', {
      method: 'PUT',
      body: JSON.stringify({
        title: { ar: arName, en: enName },
        headerTagline: { ar: tagAr, en: tagEn }
      })
    });
    await refreshState();
    toast(t('✅ تم تحديث الاسم والجملة!', '✅ Name & tagline updated!'));
    render();
  });

  // ---- footer wording: rights line, extra note, and the year toggle ----
  document.getElementById('footerTextForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const rightsAr = (fd.get('f_rights_ar') || '').trim();
    const rightsEn = (fd.get('f_rights_en') || '').trim() || rightsAr;
    const noteAr = (fd.get('f_note_ar') || '').trim();
    const noteEn = (fd.get('f_note_en') || '').trim() || noteAr;
    const yearMode = fd.get('f_year_mode') || 'auto';
    await api('/api/admin/site-config', {
      method: 'PUT',
      body: JSON.stringify({
        footerRights: { ar: rightsAr, en: rightsEn },
        footerNote: { ar: noteAr, en: noteEn },
        footerYear: yearMode === 'none' ? 0 : 'auto'
      })
    });
    await refreshState();
    toast(t('✅ تم تحديث كلام الفوتر!', '✅ Footer text updated!'));
    render();
  });

  box.querySelectorAll('[data-apply-skin]').forEach(btn => {
    btn.onclick = async () => {
      const skinId = btn.getAttribute('data-apply-skin');
      const payload = { siteTheme: skinId };
      if (skinId === 'neo_brutalist' && !cfg.showTicker) {
        payload.showTicker = true;
      } else if (skinId !== 'neo_brutalist' && activeSkin === 'neo_brutalist') {
        payload.showTicker = false;
      }
      await api('/api/admin/site-config', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      await refreshState();
      toast(t('🎨 تم تغيير ثيم الموقع بالكامل بنجاح! افتح المتجر لمشاهدته.', '🎨 Site theme updated!'));
      render();
    };
  });

  document.getElementById('cpThemeExtrasForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const splitLines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
    await api('/api/admin/site-config', {
      method: 'PUT',
      body: JSON.stringify({
        defaultTheme: fd.get('defaultTheme'),
        showTicker: fd.get('showTicker') === 'on',
        ticker: {
          ar: splitLines(fd.get('ticker_ar')),
          en: splitLines(fd.get('ticker_en'))
        }
      })
    });
    await refreshState();
    toast(t('تم حفظ إعدادات المظهر والشريط المتحرك!', 'Saved mode & ticker settings!'));
    render();
  };
}

// ================= 3. TOPICS & ARTICLES CMS =================

function renderPostsTab(box) {
  if (cp.editingPostSlug) {
    const isNew = cp.editingPostSlug === '__NEW__';
    const post = isNew ? {
      slug: '',
      status: 'published',
      pinned: false,
      date: new Date().toISOString().slice(0, 10),
      author: 'ODDWARE Lab',
      topicType: { ar: 'مقال تقني', en: 'Tech Article' },
      cover: '/assets/covers/ui-net-radar.jpg',
      linkedProject: '',
      title: { ar: '', en: '' },
      summary: { ar: '', en: '' },
      content: { ar: '', en: '' }
    } : JSON.parse(JSON.stringify(cp.data.posts.find(x => x.slug === cp.editingPostSlug)));

    box.innerHTML = `
      <div class="cp-card">
        <div class="cp-card-title">
          <span>📝 ${isNew ? t('كتابة ونشر موضوع جديد', 'Write & Publish New Topic') : t('تحرير الموضوع:', 'Edit Topic:') + ' ' + esc(post.slug)}</span>
          <button type="button" class="brutal-btn" id="backPostsBtn">← ${t('عودة للمواضيع', 'Back')}</button>
        </div>

        <form id="cpPostForm" class="form-grid">
          <div class="form-field">
            <label>${t('معرّف الرابط (اختياري — يتولد تلقائياً)', 'Slug (Optional — auto-generated)')}</label>
            <input class="brutal-input" style="max-width:100%;" name="slug" value="${esc(post.slug)}" placeholder="auto-generated" ${isNew ? '' : 'readonly'} />
          </div>
          <div class="form-field">
            <label>${t('التاريخ / الحالة / ربط بتطبيق', 'Date / Status / Linked App')}</label>
            <div style="display:grid;grid-template-columns:1fr 1fr 1.2fr auto;gap:6px;align-items:center;">
              <input type="date" class="brutal-input" style="min-width:0;" name="date" value="${esc(post.date)}" />
              <select class="brutal-select" name="status">
                <option value="published" ${post.status !== 'draft' ? 'selected' : ''}>🟢 منشور</option>
                <option value="draft" ${post.status === 'draft' ? 'selected' : ''}>📝 مسودة</option>
              </select>
              <select class="brutal-select" name="linkedProject">
                <option value="">-- بدون تطبيق مرتبط --</option>
                ${cp.data.catalog.map(c => `<option value="${esc(c.slug)}" ${post.linkedProject === c.slug ? 'selected' : ''}>${esc(pickText(c.title, cp.lang))}</option>`).join('')}
              </select>
              <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" name="pinned" ${post.pinned ? 'checked' : ''}/> 📌 تثبيت</label>
            </div>
          </div>

          <div class="form-field">
            <label>${t('عنوان الموضوع (عربي) *', 'Arabic Title *')}</label>
            <input class="brutal-input" style="max-width:100%;" name="title_ar" value="${esc(post.title?.ar)}" required />
          </div>
          <div class="form-field">
            <label>${t('العنوان بالإنجليزية (اختياري)', 'English Title (Optional)')}</label>
            <input class="brutal-input" style="max-width:100%;" name="title_en" value="${esc(post.title?.en)}" />
          </div>

          <div class="form-field">
            <label>${t('تصنيف الموضوع (عربي / إنجليزي)', 'Topic Label (AR / EN)')}</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
              <input class="brutal-input" style="min-width:0;" name="type_ar" value="${esc(post.topicType?.ar)}" placeholder="شرح تقني / أخبار" />
              <input class="brutal-input" style="min-width:0;" name="type_en" value="${esc(post.topicType?.en)}" placeholder="Tutorial / News" />
            </div>
          </div>

          <div class="form-field">
            <label>${t('صورة الموضوع + رفع مباشر', 'Cover Image')}</label>
            <div style="display:flex;gap:6px;">
              <input class="brutal-input" style="min-width:0;" name="cover" id="postCoverInp" value="${esc(post.cover)}" />
              <input type="file" id="postCoverFile" accept="image/*" style="max-width:155px;font-size:0.74rem;" />
            </div>
          </div>

          <div class="form-field">
            <label>${t('ملخص الموضوع (عربي)', 'Summary (AR)')}</label>
            <textarea class="brutal-input" style="max-width:100%;min-height:64px;" name="sum_ar">${esc(post.summary?.ar)}</textarea>
          </div>
          <div class="form-field">
            <label>Summary (EN)</label>
            <textarea class="brutal-input" style="max-width:100%;min-height:64px;" name="sum_en">${esc(post.summary?.en)}</textarea>
          </div>

          <div class="form-field full">
            <label>${t('محتوى الموضوع الكامل بالعربية (Markdown مدعوم)', 'Full Article Body (Arabic)')}</label>
            <div class="md-toolbar">
              <button type="button" class="md-tool-btn" data-pmd="### ">H3 عنوان فرعي</button>
              <button type="button" class="md-tool-btn" data-pmd="**" data-pmds="**">B خط عريض</button>
              <button type="button" class="md-tool-btn" data-pmd="&#96;" data-pmds="&#96;">Code أمر برمجي</button>
              <button type="button" class="md-tool-btn" data-pmd="\n- ">• نقطة قائمة</button>
            </div>
            <textarea class="brutal-input" id="postBodyAr" style="max-width:100%;min-height:170px;" name="body_ar">${esc(post.content?.ar)}</textarea>
          </div>

          <div class="form-field full">
            <label>Full Article Body (English)</label>
            <textarea class="brutal-input" style="max-width:100%;min-height:130px;" name="body_en">${esc(post.content?.en)}</textarea>
          </div>

          <div class="form-field full" style="display:flex;flex-direction:row;justify-content:space-between;">
            <button type="submit" class="brutal-btn volt">💾 ${t('نشر / حفظ الموضوع', 'Publish / Save Topic')}</button>
            ${!isNew ? `<button type="button" class="brutal-btn signal" id="delPostBtn">🗑️ ${t('حذف الموضوع', 'Delete Topic')}</button>` : ''}
          </div>
        </form>
      </div>
    `;

    box.querySelectorAll('[data-pmd]').forEach(b => {
      b.onclick = () => insertMdTag(document.getElementById('postBodyAr'), b.dataset.pmd, b.dataset.pmds || '');
    });

    document.getElementById('backPostsBtn').onclick = () => { cp.editingPostSlug = null; render(); };
    document.getElementById('postCoverFile')?.addEventListener('change', async e => {
      const f = e.target.files?.[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('slug', 'topic');
      fd.append('file', f);
      const d = await uploadWithProgress('/api/admin/upload/media', fd, (p, l) => setProgress(true, p, l));
      setProgress(false);
      if (d.ok) document.getElementById('postCoverInp').value = d.mediaUrl;
    });

    document.getElementById('cpPostForm').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        ...post,
        slug: fd.get('slug'),
        date: fd.get('date'),
        status: fd.get('status'),
        linkedProject: fd.get('linkedProject'),
        pinned: fd.get('pinned') === 'on',
        cover: fd.get('cover'),
        topicType: { ar: fd.get('type_ar'), en: fd.get('type_en') },
        title: { ar: fd.get('title_ar'), en: fd.get('title_en') },
        summary: { ar: fd.get('sum_ar'), en: fd.get('sum_en') },
        content: { ar: fd.get('body_ar'), en: fd.get('body_en') }
      };
      const res = await api('/api/admin/posts', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) {
        await refreshState();
        cp.editingPostSlug = null;
        toast(t('تم نشر الموضوع بنجاح!', 'Topic published!'));
        render();
      }
    };

    document.getElementById('delPostBtn')?.addEventListener('click', async () => {
      if (!confirm(t('حذف هذا الموضوع؟', 'Delete topic?'))) return;
      await api(`/api/admin/posts/${encodeURIComponent(post.slug)}`, { method: 'DELETE' });
      await refreshState();
      cp.editingPostSlug = null;
      render();
    });
    return;
  }

  box.innerHTML = `
    <div class="cp-card">
      <div class="cp-card-title">
        <span>📝 ${t('إدارة المواضيع والمقالات والشروحات', 'Topics, Devlogs & Tutorials')} (${cp.data.posts.length})</span>
        <button type="button" class="brutal-btn volt" id="newPostTrigger">+ ${t('كتابة موضوع جديد', 'Write New Topic')}</button>
      </div>
      <table class="cp-table">
        <thead>
          <tr>
            <th>${t('العنوان', 'Title')}</th>
            <th>${t('التصنيف', 'Type')}</th>
            <th>${t('التاريخ', 'Date')}</th>
            <th>${t('المشاهدات', 'Views')}</th>
            <th>${t('إجراءات', 'Actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${cp.data.posts.map(p => `
            <tr>
              <td>${p.pinned ? '📌 ' : ''}<strong>${esc(pickText(p.title, cp.lang))}</strong></td>
              <td>${esc(pickText(p.topicType, cp.lang))}</td>
              <td class="mono">${esc(p.date)}</td>
              <td class="mono">${p.views || 0}</td>
              <td><button type="button" class="brutal-btn" style="padding:5px 10px;" data-edit-post="${esc(p.slug)}">✎ ${t('تحرير', 'Edit')}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('newPostTrigger').onclick = () => { cp.editingPostSlug = '__NEW__'; render(); };
  box.querySelectorAll('[data-edit-post]').forEach(b => {
    b.onclick = () => { cp.editingPostSlug = b.dataset.editPost; render(); };
  });
}

// ================= 4. DYNAMIC CATEGORIES MANAGER =================

function renderCategoriesTab(box) {
  const cats = cp.data.categories || [];
  box.innerHTML = `
    <div class="cp-card">
      <div class="cp-card-title">🗂️ ${t('إدارة أقسام وتصنيفات المتجر الديناميكية', 'Dynamic Storefront Categories Manager')}</div>
      <div style="display:grid;gap:10px;margin-bottom:18px;">
        ${cats.map((c, idx) => `
          <div style="display:grid;grid-template-columns:60px 1fr 1fr 1fr auto;gap:8px;align-items:center;padding:10px;background:var(--bg-panel-alt);border:1.5px solid var(--border-base);">
            <input class="brutal-input" style="min-width:0;text-align:center;" data-cicon="${idx}" value="${esc(c.icon)}" />
            <input class="brutal-input mono" style="min-width:0;" data-cslug="${idx}" value="${esc(c.slug)}" />
            <input class="brutal-input" style="min-width:0;" data-car="${idx}" value="${esc(c.name?.ar)}" />
            <input class="brutal-input" style="min-width:0;" data-cen="${idx}" value="${esc(c.name?.en)}" />
            <button type="button" class="brutal-btn signal" data-crm="${idx}">✕</button>
          </div>
        `).join('')}
      </div>

      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <button type="button" class="brutal-btn" id="addCatRowBtn">+ ${t('إضافة قسم جديد', 'Add Category')}</button>
        <button type="button" class="brutal-btn volt" id="saveCatsBtn">💾 ${t('حفظ ترتيب وأسماء الأقسام', 'Save All Categories')}</button>
      </div>
    </div>
  `;

  document.getElementById('addCatRowBtn').onclick = () => {
    cp.data.categories.push({ slug: `cat-${Date.now().toString().slice(-4)}`, icon: '⚡', name: { ar: 'قسم جديد', en: 'New Category' }, order: cats.length + 1 });
    render();
  };

  box.querySelectorAll('[data-crm]').forEach(btn => {
    btn.onclick = () => {
      cp.data.categories.splice(Number(btn.dataset.crm), 1);
      render();
    };
  });

  document.getElementById('saveCatsBtn').onclick = async () => {
    const updated = cp.data.categories.map((_, idx) => ({
      icon: box.querySelector(`[data-cicon="${idx}"]`).value,
      slug: box.querySelector(`[data-cslug="${idx}"]`).value,
      name: {
        ar: box.querySelector(`[data-car="${idx}"]`).value,
        en: box.querySelector(`[data-cen="${idx}"]`).value
      },
      order: idx + 1
    }));
    await api('/api/admin/categories', { method: 'PUT', body: JSON.stringify({ categories: updated }) });
    await refreshState();
    toast(t('تم حفظ الأقسام وتحديث الموقع!', 'Categories updated!'));
    render();
  };
}

// ================= 5. PLUGINS & ADD-ONS ENGINE =================

function renderPluginsTab(box) {
  const plugins = cp.data.plugins || [];
  box.innerHTML = `
    <div style="display:grid;gap:18px;">
      <div class="cp-card">
        <div class="cp-card-title">
          <span>🧩 ${t('مركز الإضافات والملحقات البرمجية (Plugins & Extensions)', 'Plugins & Extensions Engine')}</span>
          <button type="button" class="brutal-btn volt" id="saveAllPluginsBtn">💾 ${t('حفظ جميع إعدادات الإضافات', 'Save Plugin Configurations')}</button>
        </div>
        <div style="display:grid;gap:14px;">
          ${plugins.map((pl, idx) => `
            <div style="border:2px solid ${pl.enabled ? 'var(--accent-volt)' : 'var(--border-base)'};padding:16px;background:var(--bg-panel-alt);display:grid;gap:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                <div>
                  <strong style="font-size:1rem;">${esc(pickText(pl.name, cp.lang))}</strong>
                  <span class="mono" style="font-size:0.72rem;color:var(--text-dim);margin-inline-start:8px;">[${esc(pl.id)}]</span>
                  <p style="font-size:0.84rem;color:var(--text-muted);margin-top:3px;">${esc(pickText(pl.description, cp.lang))}</p>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                  <label class="brutal-btn ${pl.enabled ? 'volt' : ''}" style="cursor:pointer;">
                    <input type="checkbox" data-pl-enable="${idx}" ${pl.enabled ? 'checked' : ''} style="margin-inline-end:6px;" />
                    ${pl.enabled ? t('مفعلة (نشطة)', 'ACTIVE') : t('معطلة', 'DISABLED')}
                  </label>
                  ${!pl.builtin ? `<button type="button" class="brutal-btn signal" data-pl-del="${esc(pl.id)}">✕</button>` : ''}
                </div>
              </div>

              ${pl.id === 'announcement-banner' ? `
                <div style="display:grid;grid-template-columns:1fr 1fr 130px;gap:8px;">
                  <input class="brutal-input" style="min-width:0;" data-pl-cfg="${idx}:textAr" value="${esc(pl.config?.textAr || '')}" placeholder="نص الإعلان بالعربية" />
                  <input class="brutal-input" style="min-width:0;" data-pl-cfg="${idx}:textEn" value="${esc(pl.config?.textEn || '')}" placeholder="English Alert Text" />
                  <input class="brutal-input mono" style="min-width:0;" data-pl-cfg="${idx}:bgColor" value="${esc(pl.config?.bgColor || '#FF3B00')}" placeholder="#FF3B00" />
                </div>
              ` : ''}

              ${pl.id === 'download-shield' ? `
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-size:0.82rem;">${t('الحد الأقصى للتحميلات في الدقيقة لكل IP:', 'Max downloads/min per IP:')}</span>
                  <input type="number" class="brutal-input" style="max-width:110px;" data-pl-cfg="${idx}:maxDownloadsPerMinute" value="${Number(pl.config?.maxDownloadsPerMinute || 25)}" />
                </div>
              ` : ''}

              ${(pl.id === 'custom-code-injector' || !pl.builtin) ? `
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                  <textarea class="brutal-input mono" style="max-width:100%;min-height:70px;font-size:0.75rem;" data-pl-cfg="${idx}:customCss" placeholder="/* Custom CSS */">${esc(pl.config?.customCss || '')}</textarea>
                  <textarea class="brutal-input mono" style="max-width:100%;min-height:70px;font-size:0.75rem;" data-pl-cfg="${idx}:customHtmlFooter" placeholder="<!-- Custom HTML Widget / Banner -->">${esc(pl.config?.customHtmlFooter || '')}</textarea>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </div>

      <div class="cp-card">
        <div class="cp-card-title">➕ ${t('إنشاء أو تثبيت إضافة مخصصة جديدة', 'Create / Install New Custom Extension')}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;">
          <input class="brutal-input" style="max-width:100%;" id="newPluginNameAr" placeholder="اسم الإضافة بالعربية (مثال: وودجت ديسكورد)" />
          <input class="brutal-input" style="max-width:100%;" id="newPluginNameEn" placeholder="Plugin English Name" />
          <button type="button" class="brutal-btn volt" id="installPluginBtn">+ ${t('تثبيت الإضافة', 'Install Plugin')}</button>
        </div>
      </div>
    </div>
  `;

  box.querySelectorAll('[data-pl-enable]').forEach(chk => {
    chk.onchange = () => {
      cp.data.plugins[Number(chk.dataset.plEnable)].enabled = chk.checked;
      render();
    };
  });

  document.getElementById('saveAllPluginsBtn').onclick = async () => {
    box.querySelectorAll('[data-pl-cfg]').forEach(inp => {
      const [iStr, key] = inp.dataset.plCfg.split(':');
      const idx = Number(iStr);
      if (!cp.data.plugins[idx].config) cp.data.plugins[idx].config = {};
      cp.data.plugins[idx].config[key] = inp.value;
    });
    await api('/api/admin/plugins', { method: 'PUT', body: JSON.stringify({ plugins: cp.data.plugins }) });
    await refreshState();
    toast(t('تم تفعيل وحفظ الإضافات!', 'Plugins saved!'));
    render();
  };

  document.getElementById('installPluginBtn').onclick = async () => {
    const ar = document.getElementById('newPluginNameAr').value.trim();
    const en = document.getElementById('newPluginNameEn').value.trim() || ar;
    if (!ar) return;
    await api('/api/admin/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ name: { ar, en }, enabled: true })
    });
    await refreshState();
    toast(t('تم تثبيت الإضافة الجديدة!', 'Custom plugin installed!'));
    render();
  };

  box.querySelectorAll('[data-pl-del]').forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/admin/plugins/${encodeURIComponent(btn.dataset.plDel)}`, { method: 'DELETE' });
      await refreshState();
      render();
    };
  });
}

// ================= 6. REVIEWS & COMMENTS MODERATION =================

function renderReviewsTab(box) {
  const revMap = cp.data.reviews || {};
  const entries = [];
  for (const [slug, arr] of Object.entries(revMap)) {
    for (const r of arr || []) entries.push({ slug, ...r });
  }

  box.innerHTML = `
    <div class="cp-card">
      <div class="cp-card-title">💬 ${t('إدارة تقييمات وتعليقات الزوار', 'Visitor Ratings & Comments Moderation')} (${entries.length})</div>
      ${entries.length === 0 ? `<p style="color:var(--text-muted);">${t('لا توجد تعليقات حتى الآن.', 'No comments yet.')}</p>` : `
        <table class="cp-table">
          <thead>
            <tr>
              <th>${t('المشروع / الموضوع', 'Target')}</th>
              <th>${t('الكاتب', 'Author')}</th>
              <th>${t('التقييم', 'Rating')}</th>
              <th>${t('التعليق', 'Comment')}</th>
              <th>${t('التاريخ', 'Date')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(r => `
              <tr>
                <td class="mono">${esc(r.slug)}</td>
                <td><strong>${esc(r.author)}</strong></td>
                <td style="color:var(--accent-volt);">${'★'.repeat(r.rating || 5)}</td>
                <td>${esc(r.comment)}</td>
                <td class="mono">${esc(r.date)}</td>
                <td><button type="button" class="brutal-btn signal" style="padding:4px 9px;" data-del-rev="${esc(r.slug)}:${esc(r.id)}">✕</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;

  box.querySelectorAll('[data-del-rev]').forEach(btn => {
    btn.onclick = async () => {
      const [slug, id] = btn.dataset.delRev.split(':');
      await api(`/api/admin/reviews/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshState();
      render();
    };
  });
}

// ================= 7. CPANEL FILE MANAGER =================

async function renderFilesTab(box) {
  box.innerHTML = `<div class="cp-card">Loading File Manager...</div>`;
  const data = await api('/api/admin/files');
  const buckets = data.buckets || {};
  const active = buckets[cp.fileBucket] || buckets.releases || { files: [] };

  box.innerHTML = `
    <div class="cp-card">
      <div class="cp-card-title">
        <span>📁 ${t('مدير الملفات والتخزين على السيرفر', 'Server Storage & File Manager')}</span>
        <label class="brutal-btn volt" style="cursor:pointer;">
          ⬆ ${t('رفع ملف أو صورة للمعرض', 'Upload Media Asset')}
          <input type="file" id="fmUploadMediaInp" style="display:none;" />
        </label>
      </div>

      <div class="filter-tabs" style="margin-bottom:14px;">
        ${Object.entries(buckets).map(([k, b]) => `
          <button type="button" class="tab-chip ${cp.fileBucket === k ? 'active' : ''}" data-fbucket="${k}">
            ${esc(b.label)} (${b.files.length})
          </button>
        `).join('')}
      </div>

      <table class="cp-table">
        <thead>
          <tr>
            <th>${t('اسم الملف', 'Filename')}</th>
            <th>${t('الحجم', 'Size')}</th>
            <th>${t('تاريخ التعديل', 'Modified')}</th>
            <th>${t('إجراءات', 'Actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${active.files.map(f => `
            <tr>
              <td class="mono">${esc(f.name)}</td>
              <td class="mono">${esc(f.sizeFormatted)}</td>
              <td class="mono">${esc(f.modifiedAt.slice(0, 19).replace('T', ' '))}</td>
              <td style="display:flex;gap:6px;">
                ${f.publicUrl ? `<button type="button" class="brutal-btn" style="padding:4px 9px;" data-copy-furl="${esc(f.publicUrl)}">🔗 Copy URL</button>` : ''}
                <button type="button" class="brutal-btn signal" style="padding:4px 9px;" data-del-file="${cp.fileBucket}:${esc(f.name)}">🗑️</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  box.querySelectorAll('[data-fbucket]').forEach(b => {
    b.onclick = () => { cp.fileBucket = b.dataset.fbucket; renderFilesTab(box); };
  });
  box.querySelectorAll('[data-copy-furl]').forEach(b => {
    b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copyFurl); toast('Copied URL!'); };
  });
  box.querySelectorAll('[data-del-file]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Delete file permanently?')) return;
      const [bkt, name] = b.dataset.delFile.split(':');
      await api(`/api/admin/files/${bkt}/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await refreshState();
      renderFilesTab(box);
    };
  });
  document.getElementById('fmUploadMediaInp').onchange = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('slug', 'asset');
    fd.append('file', f);
    await uploadWithProgress('/api/admin/upload/media', fd, (p, l) => setProgress(true, p, l));
    setProgress(false);
    cp.fileBucket = 'media';
    renderFilesTab(box);
  };
}

// ================= 8. BRANDING, BACKUP & SECURITY =================

function renderSettingsTab(box) {
  const cfg = cp.data.siteConfig || {};
  box.innerHTML = `
    <div style="display:grid;gap:20px;">
      <div class="cp-card">
        <div class="cp-card-title">🎨 ${t('الهوية البصرية ونصوص الواجهة الرئيسية', 'Site Branding, Hero Copy & Endpoints')}</div>
        <form id="cpBrandForm" class="form-grid">
          <div class="form-field">
            <label>${t('اسم المنصة بالعربية', 'Site Name (AR)')}</label>
            <input class="brutal-input" style="max-width:100%;" name="title_ar" value="${esc(cfg.title?.ar)}" />
          </div>
          <div class="form-field">
            <label>Site Name (EN)</label>
            <input class="brutal-input" style="max-width:100%;" name="title_en" value="${esc(cfg.title?.en)}" />
          </div>
          <div class="form-field">
            <label>${t('كود الهوية أعلى الشعار', 'Brand Header Code')}</label>
            <input class="brutal-input mono" style="max-width:100%;" name="brandCode" value="${esc(cfg.brandCode || '')}" />
          </div>
          <div class="form-field">
            <label>🖼️ ${t('أيقونة / شعار الموقع (ارفع الأيقونة مباشرة)', 'Site Icon / Logo Upload')}</label>
            <div style="display:flex;gap:8px;align-items:center;">
              ${cfg.logoUrl ? `<img id="cpLogoPrev" src="${esc(cfg.logoUrl)}" alt="" style="width:40px;height:40px;border-radius:10px;object-fit:cover;border:1px solid var(--border-base);" />` : `<img id="cpLogoPrev" src="" alt="" style="width:40px;height:40px;border-radius:10px;object-fit:cover;display:none;" />`}
              <input class="brutal-input mono" style="min-width:0;font-size:0.78rem;" name="logoUrl" id="cpLogoUrlInp" value="${esc(cfg.logoUrl || '')}" placeholder="/assets/covers/icon.png" />
              <label class="brutal-btn volt" style="cursor:pointer;white-space:nowrap;">
                📤 ${t('رفع أيقونة', 'Upload Icon')}
                <input type="file" id="cpLogoFileInp" accept="image/*" style="display:none;" />
              </label>
            </div>
          </div>
          <div class="form-field">
            <label>${t('لون التمييز الرئيسي (Accent Color)', 'Primary Accent Color')}</label>
            <select class="brutal-select" name="accentPreset">
              <option value="#D4FF00" ${cfg.accentPreset === '#D4FF00' ? 'selected' : ''}>⚡ Acid Volt (#D4FF00)</option>
              <option value="#00FF88" ${cfg.accentPreset === '#00FF88' ? 'selected' : ''}>🟢 Cyber Emerald (#00FF88)</option>
              <option value="#00F0FF" ${cfg.accentPreset === '#00F0FF' ? 'selected' : ''}>🔵 Electric Cyan (#00F0FF)</option>
              <option value="#FF9900" ${cfg.accentPreset === '#FF9900' ? 'selected' : ''}>🟠 Industrial Amber (#FF9900)</option>
            </select>
          </div>
          <div class="form-field full">
            <label>${t('العنوان الرئيسي (Hero AR)', 'Hero Headline (AR)')}</label>
            <input class="brutal-input" style="max-width:100%;" name="hero_ar" value="${esc(cfg.heroHeadline?.ar)}" />
          </div>
          <div class="form-field full">
            <label>Hero Headline (EN)</label>
            <input class="brutal-input" style="max-width:100%;" name="hero_en" value="${esc(cfg.heroHeadline?.en)}" />
          </div>
          <div class="form-field full">
            <label>${t('الوصف التعريفي بالواجهة (Hero Bio AR)', 'Hero Bio (AR)')}</label>
            <textarea class="brutal-input" style="max-width:100%;min-height:64px;" name="bio_ar">${esc(cfg.heroBio?.ar)}</textarea>
          </div>
          <div class="form-field">
            <label>GitLab Repository URL</label>
            <input class="brutal-input" style="max-width:100%;" name="gl_repo" value="${esc(cfg.network?.gitlabRepo)}" />
          </div>
          <div class="form-field">
            <label>GitHub Mirror URL</label>
            <input class="brutal-input" style="max-width:100%;" name="gh_repo" value="${esc(cfg.network?.githubRepo)}" />
          </div>
          <div class="form-field full">
            <button type="submit" class="brutal-btn volt">💾 ${t('حفظ إعدادات الهوية والمظهر', 'Save Branding & Appearance')}</button>
          </div>
        </form>
      </div>

      <div class="specs-two-col" style="margin-bottom:0;">
        <div class="cp-card">
          <div class="cp-card-title">🔐 ${t('تغيير كلمة مرور السي بانل', 'Change CPanel Admin Password')}</div>
          <form id="cpPassChangeForm" style="display:grid;gap:10px;">
            <input type="password" class="brutal-input" style="max-width:100%;" id="newAdminPwd" placeholder="${t('كلمة المرور الجديدة...', 'New Admin Password...')}" required />
            <button type="submit" class="brutal-btn">🔑 ${t('تحديث كلمة المرور الآن', 'Update Password')}</button>
          </form>
        </div>

        <div class="cp-card">
          <div class="cp-card-title">📦 ${t('النسخ الاحتياطي الشامل (.ZIP) وتفريغ الديمو', 'Full Backup (.ZIP), Restore & Reset')}</div>
          <div style="display:grid;gap:10px;">
            <a href="/api/admin/backup-zip?token=${encodeURIComponent(cp.token)}" class="brutal-btn volt">⬇ ${t('تحميل نسخة احتياطية كاملة (.ZIP)', 'Download Full Data Backup (.ZIP)')}</a>
            <label class="brutal-btn" style="cursor:pointer;">
              ⬆ ${t('استعادة نسخة احتياطية من ملف (.ZIP)', 'Restore Backup from .ZIP')}
              <input type="file" id="restoreZipInp" accept=".zip" style="display:none;" />
            </label>
            <button type="button" class="brutal-btn signal" id="cpPurgeAllBtn">🗑️ ${t('تفريغ كافة البيانات التجريبية والبدء من الصفر', 'Wipe Sample Content & Start Blank')}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('cpLogoFileInp')?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('slug', 'site-logo');
    fd.append('file', f);
    const d = await uploadWithProgress('/api/admin/upload/media', fd, (p, l) => setProgress(true, p, `🖼️ ${l}`));
    setProgress(false);
    if (d.ok) {
      await api('/api/admin/site-config', { method: 'PUT', body: JSON.stringify({ logoUrl: d.mediaUrl }) });
      await refreshState();
      toast(t('✅ تم رفع وتفعيل أيقونة الموقع فوراً!', '✅ Site logo uploaded & activated!'));
      render();
    }
  });

  document.getElementById('cpBrandForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/admin/site-config', {
      method: 'PUT',
      body: JSON.stringify({
        brandCode: fd.get('brandCode'),
        logoUrl: fd.get('logoUrl') || '',
        accentPreset: fd.get('accentPreset'),
        title: { ar: fd.get('title_ar'), en: fd.get('title_en') },
        heroHeadline: { ar: fd.get('hero_ar'), en: fd.get('hero_en') },
        heroBio: { ...cfg.heroBio, ar: fd.get('bio_ar') },
        network: { githubRepo: fd.get('gh_repo'), gitlabRepo: fd.get('gl_repo') }
      })
    });
    await refreshState();
    toast(t('تم حفظ إعدادات الهوية!', 'Saved branding!'));
    render();
  };

  document.getElementById('cpPassChangeForm').onsubmit = async e => {
    e.preventDefault();
    const newPassword = document.getElementById('newAdminPwd').value;
    const d = await api('/api/admin/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
    if (d.ok) {
      document.getElementById('newAdminPwd').value = '';
      toast(t('تم تحديث كلمة المرور بنجاح!', 'Password updated!'));
    }
  };

  document.getElementById('restoreZipInp').onchange = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    await uploadWithProgress('/api/admin/restore-zip', fd, (p, l) => setProgress(true, p, l));
    setProgress(false);
    await refreshState();
    toast(t('تمت استعادة النسخة الاحتياطية!', 'Backup restored!'));
    render();
  };

  document.getElementById('cpPurgeAllBtn').onclick = async () => {
    if (!confirm(t('هل أنت متأكد من حذف جميع التطبيقات والمواضيع التجريبية للبدء من الصفر؟', 'Wipe all sample apps and posts?'))) return;
    await api('/api/admin/purge-catalog', { method: 'POST' });
    await refreshState();
    toast(t('تم تفريغ المستودع بنجاح!', 'Catalog wiped clean!'));
    render();
  };
}

// ================= 9. USERS & ROLES MANAGEMENT =================

function renderUsersTab(box) {
  const users = cp.data.users || [];
  const allowReg = cp.data.siteConfig?.allowPublicRegistration !== false;

  box.innerHTML = `
    <div style="display:grid;gap:20px;">
      <div class="cp-card">
        <div class="cp-card-title">
          <span>👥 ${t(`إدارة الأعضاء والصلاحيات (${users.length})`, `Registered Users & Roles (${users.length})`)}</span>
          <button type="button" class="brutal-btn ${allowReg ? 'volt' : 'signal'}" id="togglePubRegBtn">
            ${allowReg
              ? t('✅ التسجيل العام مفتوح للأعضاء الجدد (اضغط للإيقاف)', '✅ Public Registration Open (Click to Close)')
              : t('🔒 التسجيل العام متوقف حالياً (اضغط للفتح)', '🔒 Public Registration Closed (Click to Open)')}
          </button>
        </div>
        <p style="font-size:0.86rem;color:var(--text-muted);margin-bottom:14px;">
          ${t(
            'الحساب الأول على المنصة يمتلك صلاحية المالك الأساسي دائماً. يمكنك ترقية أي عضو لمدير أو إعادته لعضو عادي.',
            'The first account created on this instance holds permanent Owner privileges. You can promote or demote secondary accounts anytime.'
          )}
        </p>

        <div style="overflow-x:auto;">
          <table class="cp-table">
            <thead>
              <tr>
                <th>${t('اسم المستخدم', 'Username')}</th>
                <th>${t('الاسم الظاهر', 'Display Name')}</th>
                <th>${t('الصلاحية', 'Role')}</th>
                <th>${t('تاريخ الانضمام', 'Joined')}</th>
                <th>${t('إجراءات', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(u => `
                <tr>
                  <td class="mono"><strong>${esc(u.username)}</strong></td>
                  <td>${esc(u.displayName || u.username)}</td>
                  <td>
                    ${u.isOwner
                      ? `<span class="tag-pill" style="background:rgba(16,185,129,0.16);color:var(--accent-emerald);">👑 ${t('المالك الأساسي (Admin)', 'Owner Admin')}</span>`
                      : u.role === 'admin'
                        ? `<span class="tag-pill" style="background:rgba(99,102,241,0.16);color:var(--accent-primary);">🛡️ ${t('مدير (Admin)', 'Admin')}</span>`
                        : `<span class="tag-pill">👤 ${t('عضو عادي', 'Member')}</span>`
                    }
                  </td>
                  <td class="mono">${esc(u.createdAt || '—')}</td>
                  <td>
                    ${u.isOwner ? `<span style="font-size:0.78rem;color:var(--text-dim);">${t('محمي (مالك المنصة)', 'Protected Owner')}</span>` : `
                      <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <button type="button" class="brutal-btn" data-toggle-role="${esc(u.id)}" data-next-role="${u.role === 'admin' ? 'member' : 'admin'}">
                          ${u.role === 'admin' ? t('تحويل لعضو عادي', 'Make Member') : t('ترقية لمدير', 'Promote to Admin')}
                        </button>
                        <button type="button" class="brutal-btn signal" data-del-user="${esc(u.id)}">
                          🗑️ ${t('حذف', 'Delete')}
                        </button>
                      </div>
                    `}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  document.getElementById('togglePubRegBtn').onclick = async () => {
    await api('/api/admin/site-config', {
      method: 'PUT',
      body: JSON.stringify({ allowPublicRegistration: !allowReg })
    });
    await refreshState();
    toast(t('تم تحديث إعداد التسجيل العام', 'Updated registration setting'));
    render();
  };

  box.querySelectorAll('[data-toggle-role]').forEach(btn => {
    btn.onclick = async () => {
      const uid = btn.getAttribute('data-toggle-role');
      const role = btn.getAttribute('data-next-role');
      await api(`/api/admin/users/${encodeURIComponent(uid)}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role })
      });
      await refreshState();
      toast(t('تم تحديث صلاحية الحساب', 'Updated user role'));
      render();
    };
  });

  box.querySelectorAll('[data-del-user]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm(t('هل تريد حذف هذا الحساب نهائياً؟', 'Delete this user account?'))) return;
      const uid = btn.getAttribute('data-del-user');
      await api(`/api/admin/users/${encodeURIComponent(uid)}`, { method: 'DELETE' });
      await refreshState();
      toast(t('تم حذف الحساب', 'User deleted'));
      render();
    };
  });
}

// Boot CPanel
(async () => {
  await checkAuthMeta();
  if (cp.token) {
    await refreshState();
  }
  render();
})();
