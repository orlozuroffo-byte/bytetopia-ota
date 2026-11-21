import { DICT, pickText } from './i18n.js';
import { ICONS, detectVisitorOS } from './icons.js';
import { renderQrSvg } from './qr.js';

const ALL_PLATFORMS = ['windows', 'linux', 'macos', 'xbox', 'android', 'ios'];
const TOKEN_KEY = 'oddware_auth_token';

const state = {
  lang: localStorage.getItem('oddware_lang') || 'ar',
  theme: localStorage.getItem('oddware_theme') || 'dark',
  token: localStorage.getItem(TOKEN_KEY) || localStorage.getItem('oddware_cpanel_token') || '',
  user: null,
  hasAdmin: true,
  allowRegistration: true,
  torOnion: '',
  visitorOS: detectVisitorOS(),
  siteConfig: {},
  categories: [],
  plugins: [],
  catalog: [],
  posts: [],
  filterCategory: 'all',
  filterPlatform: 'all',
  searchQuery: '',
  sortBy: 'featured',
  authTab: 'login',
  route: { view: 'home', slug: null }
};

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSimpleMarkdown(raw) {
  return esc(raw || '')
    .replace(/^### (.+)$/gm, '<h3 style="margin-top:18px;margin-bottom:8px;font-weight:800;color:var(--accent-primary);">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="mono" style="background:var(--bg-panel-alt);padding:2px 7px;border-radius:6px;border:1px solid var(--border-base);">$1</code>')
    .replace(/^- (.+)$/gm, '<li style="margin-inline-start:20px;margin-bottom:4px;">$1</li>')
    .replace(/\n\n/g, '<br/><br/>');
}

function showToast(msg) {
  const el = document.getElementById('toastEl');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 3000);
}

async function copyText(txt) {
  const t = DICT[state.lang];
  try {
    await navigator.clipboard.writeText(txt);
    showToast(t.copied);
  } catch (_) {
    const inp = document.createElement('textarea');
    inp.value = txt;
    document.body.appendChild(inp);
    inp.select();
    document.execCommand('copy');
    inp.remove();
    showToast(t.copied);
  }
}

function saveAuthSession(token, user) {
  state.token = token || '';
  state.user = user || null;
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem('oddware_cpanel_token', token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('oddware_cpanel_token');
  }
}

function openUtilityModal(title, innerHtml) {
  document.getElementById('utilityModalTitle').textContent = title;
  document.getElementById('utilityModalBody').innerHTML = innerHtml;
  document.getElementById('utilityModal').classList.add('open');
}

document.getElementById('closeUtilityBtn').onclick = () => {
  document.getElementById('utilityModal').classList.remove('open');
};
document.getElementById('utilityModal').addEventListener('click', e => {
  if (e.target.id === 'utilityModal') document.getElementById('utilityModal').classList.remove('open');
});

document.getElementById('closeAuthBtn').onclick = () => {
  document.getElementById('authModal').classList.remove('open');
};
document.getElementById('authModal').addEventListener('click', e => {
  if (e.target.id === 'authModal') document.getElementById('authModal').classList.remove('open');
});

function hasPlugin(id) {
  return state.plugins.find(p => p.id === id && p.enabled);
}

function applyThemeAndLang() {
  const t = DICT[state.lang] || DICT.ar;
  const html = document.documentElement;
  html.lang = t.langCode;
  html.dir = t.dir;
  html.setAttribute('data-theme', state.theme);
  const activeSkin = state.siteConfig?.siteTheme || 'modern_glass';
  html.setAttribute('data-skin', activeSkin);
  localStorage.setItem('oddware_lang', state.lang);
  localStorage.setItem('oddware_theme', state.theme);

  const siteTitle = pickText(state.siteConfig?.title, state.lang) || 'ODDWARE Store';
  const siteSub = pickText(state.siteConfig?.subtitle, state.lang) || '';
  document.title = siteSub ? `${siteTitle} — ${siteSub}` : siteTitle;
}

function renderTickerBar() {
  const slot = document.getElementById('tickerSlot');
  if (!slot) return;
  if (!state.siteConfig?.showTicker) {
    slot.innerHTML = '';
    return;
  }
  const lines = state.siteConfig?.ticker?.[state.lang] || state.siteConfig?.ticker?.ar || [];
  if (!lines.length) {
    slot.innerHTML = '';
    return;
  }
  const repeated = [...lines, ...lines, ...lines];
  slot.innerHTML = `
    <div class="ticker-wrap">
      <div class="ticker-track">
        ${repeated.map(txt => `<span>⚡ ${esc(txt)}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderVideoTrailerBlock(item) {
  const rawUrl = String(item.trailerUrl || '').trim();
  if (!rawUrl) return '';
  const isAr = state.lang === 'ar';

  // Check if YouTube URL
  const ytMatch = rawUrl.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i);
  let playerHtml = '';
  if (ytMatch) {
    playerHtml = `<iframe src="https://www.youtube.com/embed/${esc(ytMatch[1])}?rel=0" allowfullscreen loading="lazy" title="Video Trailer"></iframe>`;
  } else {
    playerHtml = `
      <video controls playsinline preload="metadata" poster="${esc(item.cover || '')}">
        <source src="${esc(rawUrl)}" />
      </video>
    `;
  }

  return `
    <div class="info-panel" style="padding:20px;">
      <h3 style="margin-bottom:14px;">🎬 ${isAr ? 'فيديو استعراض التطبيق / اللعبة (Trailer)' : 'Official Video Showcase & Gameplay'}</h3>
      <div class="video-showcase-box">
        ${playerHtml}
      </div>
    </div>
  `;
}

function injectActivePlugins() {
  let styleEl = document.getElementById('oddwarePluginCss');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'oddwarePluginCss';
    document.head.appendChild(styleEl);
  }
  let cssBundle = '';
  let footerHtml = '';
  for (const pl of state.plugins) {
    if (pl.config?.customCss) cssBundle += `\n${pl.config.customCss}`;
    if (pl.config?.customHtmlFooter) footerHtml += `\n${pl.config.customHtmlFooter}`;
  }
  styleEl.textContent = cssBundle;

  let customFooterBox = document.getElementById('oddwarePluginFooter');
  if (!customFooterBox) {
    customFooterBox = document.createElement('div');
    customFooterBox.id = 'oddwarePluginFooter';
    customFooterBox.className = 'shell';
    document.querySelector('.site-footer').before(customFooterBox);
  }
  customFooterBox.innerHTML = footerHtml;

  const alertPl = hasPlugin('announcement-banner');
  const slot = document.getElementById('pluginAlertSlot');
  if (alertPl) {
    const txt = state.lang === 'ar' ? alertPl.config?.textAr : alertPl.config?.textEn;
    slot.innerHTML = `
      <div style="background:var(--accent-gradient);color:#FFF;padding:8px 16px;text-align:center;font-weight:700;font-size:0.85rem;">
        <a href="${esc(alertPl.config?.linkUrl || '#vaultAnchor')}">${esc(txt || '')}</a>
      </div>
    `;
  } else {
    slot.innerHTML = '';
  }
}

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '');
  if (raw.startsWith('project/')) {
    state.route = { view: 'detail', slug: raw.replace('project/', '').split('?')[0].trim() };
  } else if (raw.startsWith('post/')) {
    state.route = { view: 'post', slug: raw.replace('post/', '').split('?')[0].trim() };
  } else if (raw === 'login' || raw === 'register') {
    state.route = { view: 'home', slug: null };
    setTimeout(() => openAuthModal(raw === 'register' ? 'register' : 'login'), 50);
  } else {
    state.route = { view: 'home', slug: null };
  }
}

async function fetchBootstrap() {
  const headers = {};
  if (state.token) headers['X-Session-Token'] = state.token;
  const res = await fetch('/api/bootstrap', { headers });
  const data = await res.json();
  state.siteConfig = data.siteConfig || {};
  state.categories = data.categories || [];
  state.plugins = data.plugins || [];
  state.catalog = data.catalog || [];
  state.posts = data.posts || [];
  state.hasAdmin = Boolean(data.auth?.hasAdmin);
  state.allowRegistration = data.auth?.allowRegistration !== false;
  state.user = data.auth?.user || null;
  state.torOnion = data.mirrors?.torOnion || '';

  if (state.token && !state.user) {
    saveAuthSession('', null);
  }
}

function getCategoryLabel(catSlug) {
  const found = state.categories.find(c => c.slug === catSlug);
  if (found) return `${found.icon || ''} ${pickText(found.name, state.lang)}`.trim();
  return DICT[state.lang].categoriesMap[catSlug] || catSlug;
}

function pickBestPlatform(item) {
  if (item?.platforms?.[state.visitorOS]?.available) {
    return { key: state.visitorOS, exactMatch: true, info: item.platforms[state.visitorOS] };
  }
  for (const p of ALL_PLATFORMS) {
    if (item?.platforms?.[p]?.available) {
      return { key: p, exactMatch: false, info: item.platforms[p] };
    }
  }
  return null;
}

// ================= UNIFIED AUTH MODAL (FIRST USER = AUTOMATIC ADMIN!) =================

function openAuthModal(defaultTab = null) {
  if (!state.hasAdmin) {
    state.authTab = 'register';
  } else if (defaultTab) {
    state.authTab = defaultTab;
  }
  renderAuthModalBody();
  document.getElementById('authModal').classList.add('open');
}

function renderAuthModalBody() {
  const t = DICT[state.lang];
  const isReg = state.authTab === 'register';
  document.getElementById('authModalTitle').textContent = isReg ? t.authRegisterTab : t.authLoginTab;

  const showTabs = state.hasAdmin && state.allowRegistration;

  document.getElementById('authModalBody').innerHTML = `
    ${!state.hasAdmin ? `
      <div class="owner-claim-banner">
        <strong style="display:block;margin-bottom:4px;color:var(--accent-emerald);">${esc(t.firstOwnerTitle)}</strong>
        <span style="color:var(--text-muted);">${esc(t.firstOwnerDesc)}</span>
      </div>
    ` : ''}

    ${showTabs ? `
      <div class="auth-tabs">
        <button type="button" class="auth-tab-btn ${!isReg ? 'active' : ''}" id="tabLoginSwitch">${esc(t.authLoginTab)}</button>
        <button type="button" class="auth-tab-btn ${isReg ? 'active' : ''}" id="tabRegSwitch">${esc(t.authRegisterTab)}</button>
      </div>
    ` : ''}

    <form id="authFormEl" style="display:flex;flex-direction:column;gap:14px;">
      <div class="form-field">
        <label>${esc(t.usernameLabel)}</label>
        <input type="text" class="form-input" id="authUsernameInp" required minlength="2" maxlength="40"
               autocomplete="username" placeholder="${esc(t.usernamePlaceholder)}" />
      </div>

      ${isReg ? `
        <div class="form-field">
          <label>${esc(t.displayNameLabel)}</label>
          <input type="text" class="form-input" id="authDisplayInp" maxlength="50"
                 placeholder="${esc(t.displayNamePlaceholder)}" />
        </div>
      ` : ''}

      <div class="form-field">
        <label>${esc(t.passwordLabel)}</label>
        <input type="password" class="form-input" id="authPasswordInp" required minlength="4"
               autocomplete="${isReg ? 'new-password' : 'current-password'}" placeholder="${esc(t.passwordPlaceholder)}" />
      </div>

      <div id="authErrorMsg" style="display:none;color:var(--accent-danger);font-size:0.84rem;font-weight:700;"></div>

      <button type="submit" class="btn primary" style="width:100%;padding:12px;">
        ${esc(isReg ? t.registerSubmit : t.loginSubmit)}
      </button>
    </form>
  `;

  document.getElementById('tabLoginSwitch')?.addEventListener('click', () => {
    state.authTab = 'login';
    renderAuthModalBody();
  });
  document.getElementById('tabRegSwitch')?.addEventListener('click', () => {
    state.authTab = 'register';
    renderAuthModalBody();
  });

  document.getElementById('authFormEl').onsubmit = async e => {
    e.preventDefault();
    const errBox = document.getElementById('authErrorMsg');
    errBox.style.display = 'none';

    const username = document.getElementById('authUsernameInp').value.trim();
    const password = document.getElementById('authPasswordInp').value;
    const displayName = document.getElementById('authDisplayInp')?.value?.trim() || '';

    const endpoint = isReg ? '/api/auth/register' : '/api/auth/login';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isReg ? { username, password, displayName } : { username, password })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        errBox.textContent = data.message || (state.lang === 'ar' ? 'تعذّر إتمام العملية، تأكد من البيانات' : 'Authentication failed');
        errBox.style.display = 'block';
        return;
      }

      saveAuthSession(data.token, data.user);
      if (data.user?.role === 'admin') state.hasAdmin = true;
      document.getElementById('authModal').classList.remove('open');
      renderAll();

      if (data.user?.role === 'admin') {
        showToast(t.welcomeAdminToast);
      } else {
        showToast(t.welcomeMemberToast);
      }
    } catch (_) {
      errBox.textContent = state.lang === 'ar' ? 'خطأ في الاتصال بالسيرفر' : 'Network error';
      errBox.style.display = 'block';
    }
  };
}

async function signOutUser() {
  try {
    if (state.token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Session-Token': state.token }
      });
    }
  } catch (_) {}
  saveAuthSession('', null);
  renderAll();
  showToast(state.lang === 'ar' ? 'تم تسجيل الخروج' : 'Signed out');
}

// ================= WORDPRESS-STYLE ADMIN BAR & MODERN HEADER =================

function openQuickBrandModal() {
  const isAr = state.lang === 'ar';
  const curLogo = state.siteConfig?.logoUrl || '';
  const curAr = state.siteConfig?.title?.ar || '';
  const curEn = state.siteConfig?.title?.en || '';
  const curHide = Boolean(state.siteConfig?.hideBrandText);

  openUtilityModal(
    isAr ? '🖼️ تغيير أيقونة ولوجو الموقع واسم المنصة' : '🖼️ Change Site Icon, Logo & Brand Name',
    `
      <div style="width:100%;text-align:start;display:grid;gap:14px;">
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;border-radius:14px;background:var(--bg-panel-alt);border:1.5px dashed var(--border-strong);">
          <div id="liveModalLogoBox" style="height:76px;display:flex;align-items:center;justify-content:center;">
            ${curLogo
              ? `<img src="${esc(curLogo)}" alt="Logo" style="max-height:72px;max-width:200px;border-radius:12px;object-fit:contain;" />`
              : `<span style="color:var(--text-muted);font-size:0.86rem;">${isAr ? 'ارفع أيقونة أركان أو أي شعار من جهازك' : 'Upload your site icon / logo'}</span>`}
          </div>
          <label class="btn primary" style="cursor:pointer;width:100%;">
            📤 ${isAr ? 'اختر ملف الأيقونة / اللوجو من جهازك' : 'Upload Site Icon / Logo'}
            <input type="file" id="frontLogoFileInp" accept="image/*" style="display:none;" />
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;cursor:pointer;">
            <input type="checkbox" id="frontHideBrandTxt" ${curHide ? 'checked' : ''} />
            <span>${isAr ? 'إخفاء النص الجانبي (إذا كان الاسم مكتوباً داخل اللوجو)' : 'Hide text next to logo'}</span>
          </label>
        </div>

        <div class="form-field">
          <label>${isAr ? 'اسم الموقع بالعربية' : 'Site Name (Arabic)'}</label>
          <input type="text" class="form-input" id="frontBrandAr" value="${esc(curAr)}" placeholder="أركان" />
        </div>
        <div class="form-field">
          <label>${isAr ? 'اسم الموقع بالإنجليزية' : 'Site Name (English)'}</label>
          <input type="text" class="form-input" id="frontBrandEn" value="${esc(curEn)}" placeholder="ARKAN" />
        </div>

        <button type="button" class="btn primary" id="frontSaveBrandBtn" style="width:100%;padding:12px;">
          💾 ${isAr ? 'حفظ وتطبيق الهوية الآن' : 'Save & Apply Branding'}
        </button>
      </div>
    `
  );

  let uploadedLogoUrl = curLogo;

  document.getElementById('frontLogoFileInp').onchange = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('slug', 'site-logo');
    fd.append('file', f);
    const res = await fetch('/api/admin/upload/media', {
      method: 'POST',
      headers: { 'X-Session-Token': state.token, 'X-Admin-Token': state.token },
      body: fd
    });
    const d = await res.json();
    if (d.ok) {
      uploadedLogoUrl = d.mediaUrl;
      document.getElementById('liveModalLogoBox').innerHTML =
        `<img src="${esc(uploadedLogoUrl)}" alt="Logo" style="max-height:72px;max-width:200px;border-radius:12px;object-fit:contain;" />`;
      showToast(isAr ? '✅ تم رفع الأيقونة — اضغط حفظ لتطبيقها' : '✅ Icon uploaded — click Save');
    }
  };

  document.getElementById('frontSaveBrandBtn').onclick = async () => {
    const arVal = document.getElementById('frontBrandAr').value.trim() || curAr;
    const enVal = document.getElementById('frontBrandEn').value.trim() || arVal;
    const hideVal = document.getElementById('frontHideBrandTxt').checked;
    await fetch('/api/admin/site-config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': state.token,
        'X-Admin-Token': state.token
      },
      body: JSON.stringify({
        logoUrl: uploadedLogoUrl,
        hideBrandText: hideVal,
        title: { ar: arVal, en: enVal }
      })
    });
    document.getElementById('utilityModal').classList.remove('open');
    await fetchBootstrap();
    renderAll();
    showToast(isAr ? '🎉 تم تحديث أيقونة واسم الموقع فوراً!' : '🎉 Site icon & name updated!');
  };
}

function openQuickOtaModal() {
  const isAr = state.lang === 'ar';
  openUtilityModal(
    isAr ? '🔐 التحديث المباشر من المستودع بالبصمة الرقمية (SHA-256)' : '🔐 Cryptographic SHA-256 Repository Updater',
    `
      <div id="frontOtaBody" style="width:100%;text-align:start;display:grid;gap:12px;">
        <div style="color:var(--text-muted);font-size:0.9rem;">
          ⏳ ${isAr ? 'جاري فحص المستودع والتحقق من البصمة الرقمية SHA-256...' : 'Checking repository SHA-256 manifest...'}
        </div>
      </div>
    `
  );

  (async () => {
    const box = document.getElementById('frontOtaBody');
    try {
      const res = await fetch('/api/admin/ota/check', {
        headers: { 'X-Session-Token': state.token, 'X-Admin-Token': state.token }
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'CHECK_FAILED');

      box.innerHTML = `
        <div style="padding:12px;border-radius:12px;background:var(--bg-panel-alt);border:1px solid var(--border-base);display:grid;gap:6px;font-size:0.84rem;">
          <div><strong>${isAr ? 'الإصدار الحالي:' : 'Current Version:'}</strong> <span class="mono">v${esc(d.local?.version)} (#${d.local?.buildSeq})</span></div>
          <div class="mono" style="font-size:0.72rem;color:var(--text-muted);word-break:break-all;">Local SHA-256: ${esc(d.local?.bundleSha256)}</div>
          <hr style="border:none;border-top:1px solid var(--border-base);margin:4px 0;" />
          <div><strong>${isAr ? 'نسخة المستودع:' : 'Repository Version:'}</strong> <span class="mono" style="color:var(--accent-emerald);">v${esc(d.remote?.version)} (#${d.remote?.buildSeq})</span></div>
          <div class="mono" style="font-size:0.72rem;color:var(--accent-emerald);word-break:break-all;">Remote SHA-256: ${esc(d.remote?.bundleSha256)}</div>
        </div>

        <div style="font-weight:800;color:${d.updateAvailable ? 'var(--accent-emerald)' : 'var(--text-main)'};font-size:0.9rem;">
          ${d.updateAvailable
            ? (isAr ? `🚀 يوجد تحديث جديد (${d.changedFilesCount} ملفات متغيرة — ${d.totalDownloadFormatted})` : `🚀 New verified update (${d.changedFilesCount} files)`)
            : (isAr ? '✅ نسختك الحالية مطابقة 100% لبصمة المستودع!' : '✅ Your system matches 100% of the repository SHA-256 fingerprint!')}
        </div>

        <button type="button" class="btn primary" id="frontApplyOtaNowBtn" style="width:100%;padding:12px;">
          ⬇️ ${isAr ? 'سحب وتثبيت التحديث الموثّق بالبصمة الآن' : 'Pull & Install Verified Update Now'}
        </button>
      `;

      document.getElementById('frontApplyOtaNowBtn').onclick = async ev => {
        ev.target.disabled = true;
        ev.target.textContent = isAr ? '🔐 جاري التحميل والتحقق من البصمة SHA-256...' : '🔐 Verifying SHA-256 & Applying...';
        const aRes = await fetch('/api/admin/ota/apply', {
          method: 'POST',
          headers: { 'X-Session-Token': state.token, 'X-Admin-Token': state.token }
        });
        const aData = await aRes.json();
        if (aData.ok) {
          showToast(isAr ? '🎉 تم التحديث بالبصمة بنجاح! جاري تحديث الصفحة...' : '🎉 Verified update applied! Reloading...');
          setTimeout(() => window.location.reload(), 1600);
        } else {
          ev.target.disabled = false;
          showToast(`⚠️ ${aData.error || 'Update failed'}`);
        }
      };
    } catch (err) {
      if (box) box.innerHTML = `<div style="color:var(--accent-danger);font-weight:700;">⚠️ ${esc(err.message)}</div>`;
    }
  })();
}

function renderAdminTopBar() {
  const bar = document.getElementById('adminTopBar');
  const t = DICT[state.lang];
  if (!state.user || state.user.role !== 'admin') {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  bar.style.display = 'block';
  bar.innerHTML = `
    <div class="shell admin-topbar-inner">
      <div style="display:flex;align-items:center;gap:10px;">
        <span>🛡️ <strong>${esc(t.adminBarGreeting)}:</strong> ${esc(state.user.displayName || state.user.username)}</span>
      </div>
      <div class="admin-topbar-links">
        <button type="button" class="admin-pill-link primary" id="topBarOtaBtn" style="border:none;cursor:pointer;">
          ⚡ ${state.lang === 'ar' ? 'تحديث من المستودع' : 'OTA Update'}
        </button>
        <button type="button" class="admin-pill-link" id="topBarBrandBtn" style="border:none;cursor:pointer;">
          🖼️ ${state.lang === 'ar' ? 'تغيير الأيقونة والاسم' : 'Change Logo & Name'}
        </button>
        <a href="/admin" class="admin-pill-link">⚙️ ${esc(t.adminPanelBtn)} (CPanel)</a>
        <a href="/admin#apps" class="admin-pill-link">${esc(t.adminQuickApp)}</a>
        <a href="/admin#posts" class="admin-pill-link">${esc(t.adminQuickPost)}</a>
      </div>
    </div>
  `;

  document.getElementById('topBarOtaBtn')?.addEventListener('click', openQuickOtaModal);
  document.getElementById('topBarBrandBtn')?.addEventListener('click', openQuickBrandModal);
}

function renderHeader() {
  const t = DICT[state.lang];
  const nameEl = document.getElementById('brandNameEl');
  const subEl = document.getElementById('brandSubEl');
  const textWrap = document.querySelector('#brandHomeLink .brand-text');

  nameEl.textContent = pickText(state.siteConfig?.title, state.lang) || 'ByteTopia';
  // a tagline next to the icon wins over the plain subtitle when the admin sets one
  const tagline = (pickText(state.siteConfig?.headerTagline, state.lang) || '').trim();
  subEl.textContent = tagline || pickText(state.siteConfig?.subtitle, state.lang) || '';
  subEl.classList.toggle('is-tagline', Boolean(tagline));

  const markEl = document.querySelector('#brandHomeLink .brand-mark');
  if (markEl) {
    if (state.siteConfig?.logoUrl) {
      markEl.classList.add('has-custom-logo');
      markEl.innerHTML = `<img src="${esc(state.siteConfig.logoUrl)}" alt="Logo" />`;
      const fav = document.querySelector('link[rel="icon"]');
      if (fav) fav.href = state.siteConfig.logoUrl;
      if (textWrap) {
        textWrap.style.display = state.siteConfig?.hideBrandText ? 'none' : 'flex';
      }
    } else {
      markEl.classList.remove('has-custom-logo');
      markEl.textContent = (state.siteConfig?.brandCode || 'Ø').slice(0, 2);
      if (textWrap) textWrap.style.display = 'flex';
    }
  }

  const isAdmin = state.user?.role === 'admin';
  const avatarChar = (state.user?.username || 'U').slice(0, 1).toUpperCase();

  document.getElementById('headerControls').innerHTML = `
    <a href="#vaultAnchor" class="btn ghost">${esc(t.navStore)}</a>
    ${state.posts.length > 0 ? `<a href="#topicsAnchor" class="btn ghost">${esc(t.navTopics)}</a>` : ''}

    <button class="btn ghost" id="themeToggleBtn" type="button" title="Theme">
      <span>${state.theme === 'dark' ? '☀️' : '🌙'}</span>
    </button>

    <button class="btn ghost" id="langToggleBtn" type="button">
      <span class="mono" style="font-size:0.8rem;">${esc(t.langSwitchLabel)}</span>
    </button>

    ${state.user ? `
      ${isAdmin ? `<a href="/admin" class="btn emerald">🛡️ ${esc(t.adminPanelBtn)}</a>` : ''}
      <div class="user-chip">
        <span class="user-avatar">${esc(avatarChar)}</span>
        <span>${esc(state.user.username)}</span>
      </div>
      <button class="btn ghost" id="logoutHeaderBtn" type="button" style="font-size:0.8rem;">${esc(t.signOutBtn)}</button>
    ` : `
      <button class="btn primary" id="openAuthHeaderBtn" type="button">
        <span>👤 ${esc(!state.hasAdmin ? t.registerBtn : t.signInBtn)}</span>
      </button>
    `}
  `;

  document.getElementById('themeToggleBtn').onclick = () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyThemeAndLang();
    renderAll();
  };

  document.getElementById('langToggleBtn').onclick = () => {
    state.lang = state.lang === 'ar' ? 'en' : 'ar';
    applyThemeAndLang();
    renderAll();
  };

  document.getElementById('openAuthHeaderBtn')?.addEventListener('click', () => openAuthModal());
  document.getElementById('logoutHeaderBtn')?.addEventListener('click', signOutUser);
}

// ================= HOME STOREFRONT VIEW =================

function getFilteredCatalog() {
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = state.catalog.filter(item => {
    if (state.filterCategory !== 'all' && item.category !== state.filterCategory) return false;
    if (state.filterPlatform !== 'all') {
      if (!item.platforms?.[state.filterPlatform]?.available) return false;
    }
    if (q) {
      const hay = [
        item.slug,
        item.techStack,
        item.category,
        item.title?.ar,
        item.title?.en,
        item.tagline?.ar,
        item.tagline?.en,
        ...(item.tags?.ar || []),
        ...(item.tags?.en || [])
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    if (state.sortBy === 'downloads') return (b.stats?.totalDownloads || 0) - (a.stats?.totalDownloads || 0);
    if (state.sortBy === 'newest') return String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''));
    if (Boolean(b.featured) !== Boolean(a.featured)) return b.featured ? 1 : -1;
    return (b.stats?.totalDownloads || 0) - (a.stats?.totalDownloads || 0);
  });
}

function renderHomeView(root) {
  const t = DICT[state.lang];
  const featured = state.catalog.find(x => x.featured) || state.catalog[0];
  const totalDls = state.catalog.reduce((acc, x) => acc + (x.stats?.totalDownloads || 0), 0);
  const filtered = getFilteredCatalog();
  const featBest = featured ? pickBestPlatform(featured) : null;

  root.innerHTML = `
    <section class="hero-section">
      <div class="hero-grid">
        <div class="hero-manifesto">
          <div style="display:flex;flex-direction:column;gap:14px;">
            <span class="eyebrow-tag">✨ ${esc(t.heroBadge)}</span>
            <h1 class="hero-title">${esc(pickText(state.siteConfig?.heroHeadline, state.lang))}</h1>
            <p class="hero-bio">${esc(pickText(state.siteConfig?.heroBio, state.lang))}</p>
          </div>

          <div class="hero-actions">
            <a href="#vaultAnchor" class="btn primary">${esc(t.heroExploreBtn)}</a>
            ${state.posts.length > 0 ? `<a href="#topicsAnchor" class="btn">${esc(t.heroTopicsBtn)}</a>` : ''}
          </div>

          <div style="display:flex;flex-direction:column;gap:16px;">
            <div class="platform-dock" role="group">
              ${ALL_PLATFORMS.map(p => `
                <button type="button"
                  class="plat-dock-btn ${state.filterPlatform === p ? 'active' : ''} ${state.visitorOS === p ? 'detected-os' : ''}"
                  data-plat-dock="${p}">
                  ${ICONS[p]}
                  <span>${esc(t.platformsShort[p])}</span>
                </button>
              `).join('')}
            </div>

            <div class="hero-stats">
              <div class="stat-cell">
                <span class="stat-num">${state.catalog.length}</span>
                <span class="stat-label">${esc(t.statSoftware)}</span>
              </div>
              <div class="stat-cell">
                <span class="stat-num">${totalDls.toLocaleString()}</span>
                <span class="stat-label">${esc(t.statDownloads)}</span>
              </div>
              <div class="stat-cell">
                <span class="stat-num" style="color:var(--accent-emerald);">100%</span>
                <span class="stat-label">${esc(t.statVerified)}</span>
              </div>
            </div>
          </div>
        </div>

        ${featured ? `
        <article class="hero-spotlight">
          <a href="#project/${esc(featured.slug)}" class="spotlight-media">
            <img src="${esc(featured.cover)}" alt="${esc(pickText(featured.title, state.lang))}" />
            <span class="spotlight-stamp">⭐ ${esc(t.featuredStamp)}</span>
            <span class="version-pill">${esc(featured.version)}</span>
          </a>
          <div class="spotlight-body">
            <div>
              <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:4px;">
                ${esc(getCategoryLabel(featured.category))}
              </div>
              <h2 class="spotlight-title">${esc(pickText(featured.title, state.lang))}</h2>
              <p class="spotlight-desc" style="margin-top:6px;">${esc(pickText(featured.tagline, state.lang))}</p>
            </div>
            <div class="spotlight-cta-row">
              ${featBest ? `
                <a href="/api/download/${esc(featured.slug)}/${esc(featBest.key)}"
                   class="btn primary"
                   data-dl-track="${esc(featured.slug)}:${esc(featBest.key)}">
                  ${ICONS[featBest.key]}
                  <span>${esc(t.smartDownloadFor)} ${esc(t.platformsShort[featBest.key])}</span>
                </a>
              ` : ''}
              <a href="#project/${esc(featured.slug)}" class="btn">${esc(t.viewAllPackages)}</a>
            </div>
          </div>
        </article>
        ` : `
        <div class="hero-spotlight" style="align-items:center;justify-content:center;padding:36px;text-align:center;">
          <p style="color:var(--text-muted);">${state.lang === 'ar' ? 'قريباً — سيتم نشر أحدث التطبيقات هنا.' : 'New apps arriving soon.'}</p>
        </div>
        `}
      </div>
    </section>

    <section class="vault-section" id="vaultAnchor">
      <div class="section-head">
        <div>
          <h2 class="section-title">${esc(t.vaultTitle)}</h2>
          <p class="section-sub">${esc(t.vaultSub)}</p>
        </div>
      </div>

      <div class="filter-console">
        <div class="filter-tabs">
          <button type="button" class="tab-chip ${state.filterCategory === 'all' ? 'active' : ''}" data-fcat="all">
            ${esc(t.catAll)} (${state.catalog.length})
          </button>
          ${state.categories.map(cat => `
            <button type="button" class="tab-chip ${state.filterCategory === cat.slug ? 'active' : ''}" data-fcat="${esc(cat.slug)}">
              ${esc(cat.icon)} ${esc(pickText(cat.name, state.lang))}
            </button>
          `).join('')}
        </div>

        <div class="filter-inputs">
          <input type="search" id="searchBox" class="search-input"
                 value="${esc(state.searchQuery)}"
                 placeholder="${esc(t.searchPlaceholder)}" />

          <select id="platFilterSelect" class="select-box">
            <option value="all">${esc(t.filterAllPlatforms)}</option>
            ${ALL_PLATFORMS.map(p => `
              <option value="${p}" ${state.filterPlatform === p ? 'selected' : ''}>${esc(t.platforms[p])}</option>
            `).join('')}
          </select>

          <select id="sortSelect" class="select-box">
            <option value="featured" ${state.sortBy === 'featured' ? 'selected' : ''}>${esc(t.sortFeatured)}</option>
            <option value="downloads" ${state.sortBy === 'downloads' ? 'selected' : ''}>${esc(t.sortDownloads)}</option>
            <option value="newest" ${state.sortBy === 'newest' ? 'selected' : ''}>${esc(t.sortNewest)}</option>
          </select>
        </div>
      </div>

      ${filtered.length === 0 ? `
        <div class="info-panel" style="text-align:center;padding:46px 20px;">
          <p style="color:var(--text-muted);margin-bottom:16px;">${esc(t.noResults)}</p>
          <button type="button" class="btn" id="resetFiltersBtn">${esc(t.resetFilters)}</button>
        </div>
      ` : `
        <div class="catalog-grid">
          ${filtered.map(item => renderAppCard(item, t)).join('')}
        </div>
      `}
    </section>

    ${state.posts.length > 0 ? `
      <section class="vault-section" id="topicsAnchor" style="padding-top:10px;">
        <div class="section-head">
          <div>
            <h2 class="section-title">${esc(t.navTopics)}</h2>
            <p class="section-sub">${state.lang === 'ar' ? 'أحدث الشروحات، المراجعات، وأخبار التحديثات' : 'Guides, release notes, and technical articles'}</p>
          </div>
        </div>
        <div class="topics-grid">
          ${state.posts.map(post => `
            <article class="topic-card">
              ${post.cover ? `
                <a href="#post/${esc(post.slug)}" class="card-cover" style="aspect-ratio:16/8.5;">
                  <img src="${esc(post.cover)}" alt="${esc(pickText(post.title, state.lang))}" />
                  <span class="card-cat-badge">${esc(pickText(post.topicType, state.lang))}</span>
                </a>
              ` : ''}
              <div class="card-body">
                <div>
                  <div style="font-size:0.76rem;color:var(--text-dim);margin-bottom:6px;">
                    ${esc(post.date || '')}
                  </div>
                  <a href="#post/${esc(post.slug)}"><h3 class="card-title">${esc(pickText(post.title, state.lang))}</h3></a>
                  <p class="card-tagline">${esc(pickText(post.summary, state.lang))}</p>
                </div>
                <a href="#post/${esc(post.slug)}" class="btn" style="width:100%;">
                  ${state.lang === 'ar' ? 'قراءة المقال كاملاً ←' : 'Read Article →'}
                </a>
              </div>
            </article>
          `).join('')}
        </div>
      </section>
    ` : ''}
  `;

  root.querySelectorAll('[data-plat-dock]').forEach(btn => {
    btn.onclick = () => {
      const p = btn.getAttribute('data-plat-dock');
      state.filterPlatform = state.filterPlatform === p ? 'all' : p;
      renderHomeView(root);
      document.getElementById('vaultAnchor')?.scrollIntoView({ behavior: 'smooth' });
    };
  });

  root.querySelectorAll('[data-fcat]').forEach(btn => {
    btn.onclick = () => {
      state.filterCategory = btn.getAttribute('data-fcat');
      renderHomeView(root);
    };
  });

  const searchBox = document.getElementById('searchBox');
  if (searchBox) {
    searchBox.oninput = e => {
      state.searchQuery = e.target.value;
      const pos = e.target.selectionStart;
      renderHomeView(root);
      const next = document.getElementById('searchBox');
      if (next) {
        next.focus();
        next.setSelectionRange(pos, pos);
      }
    };
  }

  document.getElementById('platFilterSelect')?.addEventListener('change', e => {
    state.filterPlatform = e.target.value;
    renderHomeView(root);
  });

  document.getElementById('sortSelect')?.addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderHomeView(root);
  });

  document.getElementById('resetFiltersBtn')?.addEventListener('click', () => {
    state.filterCategory = 'all';
    state.filterPlatform = 'all';
    state.searchQuery = '';
    renderHomeView(root);
  });

  wireDownloadCounters(root);
}

function renderAppCard(item, t) {
  const best = pickBestPlatform(item);
  const availPlats = ALL_PLATFORMS.filter(p => item.platforms?.[p]?.available);
  const dlCount = item.stats?.totalDownloads || 0;
  const avgRating = item.stats?.avgRating || 0;

  return `
    <article class="app-card">
      <a href="#project/${esc(item.slug)}" class="card-cover">
        <img src="${esc(item.cover)}" alt="${esc(pickText(item.title, state.lang))}" loading="lazy" />
        <span class="card-cat-badge">${esc(getCategoryLabel(item.category))}</span>
        ${item.trailerUrl ? `<span class="card-video-badge">🎬 ${state.lang === 'ar' ? 'فيديو' : 'Video'}</span>` : ''}
      </a>
      <div class="card-body">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
            <span class="mono" style="font-size:0.75rem;color:var(--accent-emerald);font-weight:700;">${esc(item.version || 'v1.0')}</span>
            <span style="font-size:0.76rem;color:var(--text-dim);">
              ${avgRating ? `⭐ ${avgRating} • ` : ''}${dlCount.toLocaleString()} ${esc(t.downloadsUnit)}
            </span>
          </div>
          <a href="#project/${esc(item.slug)}">
            <h3 class="card-title">${esc(pickText(item.title, state.lang))}</h3>
          </a>
          <p class="card-tagline">${esc(pickText(item.tagline, state.lang))}</p>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="card-plats-row">
            <div class="avail-plats">
              ${availPlats.map(pk => `
                <span class="plat-mini-badge" title="${esc(t.platforms[pk])}">
                  ${ICONS[pk]}
                  <span>${esc(t.platformsShort[pk])}</span>
                </span>
              `).join('')}
            </div>
          </div>

          <div class="card-actions">
            ${best ? `
              <a href="/api/download/${esc(item.slug)}/${esc(best.key)}"
                 class="btn primary"
                 data-dl-track="${esc(item.slug)}:${esc(best.key)}">
                ${ICONS[best.key]}
                <span>${esc(t.downloadDirect)}</span>
              </a>
            ` : `<span></span>`}
            <a href="#project/${esc(item.slug)}" class="btn">${esc(t.openStorePage)}</a>
          </div>
        </div>
      </div>
    </article>
  `;
}

// ================= SHA-256 VERIFIER & REVIEWS WIDGETS =================

function renderShaVerifierWidget() {
  if (!hasPlugin('sha256-verifier')) return '';
  const isAr = state.lang === 'ar';
  return `
    <div class="info-panel">
      <h3>🛡️ ${isAr ? 'فحص سلامة الملف بالبصمة الرقمية (SHA-256)' : 'Verify Downloaded File (SHA-256)'}</h3>
      <p style="font-size:0.86rem;color:var(--text-muted);margin-bottom:12px;">
        ${isAr
          ? 'اختر الملف بعد تحميله للتأكد محلياً على متصفحك من تطابق بصمته الرقمية بنسبة 100% دون رفع الملف لأي سيرفر.'
          : 'Select your downloaded installer to verify its SHA-256 checksum locally inside your browser.'}
      </p>
      <input type="file" id="shaVerifyFileInput" class="form-input" style="cursor:pointer;" />
      <div id="shaVerifyResult" style="margin-top:10px;font-size:0.85rem;"></div>
    </div>
  `;
}

function wireShaVerifier(item) {
  const inp = document.getElementById('shaVerifyFileInput');
  const out = document.getElementById('shaVerifyResult');
  if (!inp || !out) return;

  const knownHashes = Object.entries(item.platforms || {})
    .filter(([, v]) => v?.available && v?.sha256)
    .map(([k, v]) => ({ plat: k, sha: String(v.sha256).toLowerCase() }));

  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    out.innerHTML = `<span style="color:var(--text-muted);">${state.lang === 'ar' ? 'جاري حساب البصمة الرقمية...' : 'Computing SHA-256...'}</span>`;
    try {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      const match = knownHashes.find(h => h.sha === hex);
      if (match) {
        out.innerHTML = `<div style="color:var(--accent-emerald);font-weight:700;">✅ ${state.lang === 'ar' ? 'الملف سليم ومطابق تماماً للنسخة الرسمية!' : ' Authentic! Checksum matches official release.'}<div class="mono" style="font-size:0.74rem;margin-top:4px;">${hex}</div></div>`;
      } else {
        out.innerHTML = `<div style="color:var(--accent-amber);font-weight:700;">ℹ️ SHA-256:<div class="mono" style="font-size:0.75rem;margin-top:4px;">${hex}</div></div>`;
      }
    } catch (_) {
      out.textContent = '';
    }
  };
}

async function mountReviewsWidget(containerId, targetSlug) {
  const box = document.getElementById(containerId);
  if (!box || !hasPlugin('local-reviews')) return;

  const isAr = state.lang === 'ar';
  let reviews = [];
  try {
    const res = await fetch(`/api/reviews/${encodeURIComponent(targetSlug)}`);
    const data = await res.json();
    reviews = data.reviews || [];
  } catch (_) {}

  const draw = () => {
    box.innerHTML = `
      <div class="info-panel">
        <h3>💬 ${isAr ? `التقييمات والتعليقات (${reviews.length})` : `Ratings & Reviews (${reviews.length})`}</h3>

        <form id="revForm_${esc(targetSlug)}" style="display:grid;gap:10px;margin-bottom:20px;background:var(--bg-panel-alt);padding:16px;border-radius:var(--radius-md);">
          <div style="display:grid;grid-template-columns:1fr auto;gap:10px;">
            ${state.user ? `
              <div style="display:flex;align-items:center;gap:8px;font-size:0.88rem;font-weight:700;">
                <span>👤 ${esc(state.user.displayName || state.user.username)}</span>
              </div>
            ` : `
              <input type="text" id="revAuthorInp" class="form-input" maxlength="40"
                     placeholder="${isAr ? 'اسمك...' : 'Your name...'}" />
            `}
            <select id="revRatingInp" class="select-box" style="width:auto;">
              <option value="5">⭐⭐⭐⭐⭐ (5/5)</option>
              <option value="4">⭐⭐⭐⭐ (4/5)</option>
              <option value="3">⭐⭐⭐ (3/5)</option>
              <option value="2">⭐⭐ (2/5)</option>
              <option value="1">⭐ (1/5)</option>
            </select>
          </div>
          <textarea id="revCommentInp" class="form-input" rows="2" required maxlength="600"
                    placeholder="${isAr ? 'شارك رأيك أو تجربتك مع هذا التطبيق...' : 'Write your review...'}"></textarea>
          <button type="submit" class="btn primary" style="width:fit-content;">
            ${isAr ? 'إرسال التقييم' : 'Post Review'}
          </button>
        </form>

        <div style="display:grid;gap:12px;">
          ${reviews.map(r => `
            <div style="padding:14px;border-radius:var(--radius-md);border:1px solid var(--border-base);background:var(--bg-input);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <strong>${esc(r.author)}</strong>
                  ${r.role === 'admin' ? `<span class="rec-ribbon">${esc(DICT[state.lang].roleAdmin)}</span>` : ''}
                </div>
                <span style="font-size:0.8rem;color:var(--text-muted);">${'⭐'.repeat(Number(r.rating || 5))} • ${esc(r.date || '')}</span>
              </div>
              <p style="font-size:0.9rem;color:var(--text-muted);">${esc(r.comment)}</p>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    document.getElementById(`revForm_${targetSlug}`).onsubmit = async e => {
      e.preventDefault();
      const author = document.getElementById('revAuthorInp')?.value || '';
      const rating = Number(document.getElementById('revRatingInp').value || 5);
      const comment = document.getElementById('revCommentInp').value.trim();
      if (!comment) return;

      const headers = { 'Content-Type': 'application/json' };
      if (state.token) headers['X-Session-Token'] = state.token;

      const res = await fetch(`/api/reviews/${encodeURIComponent(targetSlug)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ author, rating, comment })
      });
      const data = await res.json();
      if (data.ok) {
        reviews = data.reviews || [];
        draw();
        showToast(isAr ? 'تم نشر تقييمك بنجاح!' : 'Review submitted!');
      }
    };
  };

  draw();
}

// ================= DETAIL APP / GAME PAGE =================

function renderDetailView(root) {
  const t = DICT[state.lang];
  const item = state.catalog.find(x => x.slug === state.route.slug);
  if (!item) {
    window.location.hash = '#vault';
    return;
  }

  const best = pickBestPlatform(item);
  const availPlatforms = ALL_PLATFORMS
    .filter(k => item.platforms?.[k]?.available)
    .sort((a, b) => (a === state.visitorOS ? -1 : b === state.visitorOS ? 1 : 0));

  const highlights = item.highlights?.[state.lang] || item.highlights?.ar || [];
  const changelog = item.changelog?.[state.lang] || item.changelog?.ar || [];
  const shots = Array.isArray(item.screenshots) && item.screenshots.length ? item.screenshots : [item.cover];
  const isAdmin = state.user?.role === 'admin';

  root.innerHTML = `
    <section class="detail-view">
      <div class="detail-topbar">
        <a href="#vaultAnchor" class="btn">${esc(t.backToVault)}</a>
        <div style="display:flex;align-items:center;gap:8px;">
          ${isAdmin ? `<a href="/admin" class="btn emerald">✏️ ${state.lang === 'ar' ? 'تعديل في لوحة التحكم' : 'Edit in Control Panel'}</a>` : ''}
        </div>
      </div>

      <div class="detail-hero-card">
        <div>
          <div class="detail-cover-wrap">
            <img src="${esc(item.cover)}" id="mainDetailImg" data-zoom-img="${esc(item.cover)}" alt="${esc(pickText(item.title, state.lang))}" />
          </div>
          ${shots.length > 1 ? `
            <div class="thumbs-row">
              ${shots.map(s => `<img src="${esc(s)}" data-thumb-src="${esc(s)}" alt="" />`).join('')}
            </div>
          ` : ''}
        </div>

        <div style="display:flex;flex-direction:column;justify-content:space-between;gap:20px;">
          <div style="display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="eyebrow-tag">${esc(getCategoryLabel(item.category))}</span>
              <span class="rec-ribbon">${esc(item.version || 'v1.0')} • ${esc(t.channelsMap[item.channel] || 'Stable')}</span>
            </div>
            <h1 class="detail-title">${esc(pickText(item.title, state.lang))}</h1>
            <p style="color:var(--text-muted);font-size:0.98rem;">${esc(pickText(item.tagline, state.lang))}</p>
            <div style="color:var(--text-muted);font-size:0.92rem;margin-top:6px;">
              ${renderSimpleMarkdown(pickText(item.description, state.lang))}
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:10px;padding-top:16px;border-top:1px solid var(--border-base);">
            ${best ? `
              <a href="${esc( best.info.externalUrl || `/api/download/${item.slug}/${best.key}` )}"
                 class="btn primary"
                 data-dl-track="${esc(item.slug)}:${esc(best.key)}"
                 style="padding:12px 22px;font-size:0.96rem;">
                ${ICONS[best.key]}
                <span>${esc(t.smartDownloadFor)} ${esc(t.platformsShort[best.key])} (${esc(best.info.size || '')})</span>
              </a>
              <button type="button" class="btn" id="heroQrBtn">${esc(t.qrBtn)}</button>
            ` : ''}
            ${item.optionalDemo?.enabled && item.optionalDemo?.url ? `
              <a href="${esc(item.optionalDemo.url)}" target="_blank" rel="noopener" class="btn">${esc(t.optionalDemoBtn)} ↗</a>
            ` : ''}
          </div>
        </div>
      </div>

      ${renderVideoTrailerBlock(item)}

      <div class="specs-two-col">
        <div class="info-panel">
          <h3>✨ ${esc(t.highlightsTitle)}</h3>
          <ul style="padding-inline-start:18px;display:grid;gap:9px;color:var(--text-muted);margin-bottom:18px;">
            ${highlights.map(h => `<li>${esc(h)}</li>`).join('')}
          </ul>

          ${changelog.length ? `
            <h3>📋 ${esc(t.changelogTitle)}</h3>
            <ul style="padding-inline-start:18px;display:grid;gap:7px;color:var(--text-muted);font-size:0.88rem;">
              ${changelog.map(line => `<li>${esc(line)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>

        <div class="info-panel">
          <h3>💻 ${esc(t.reqsTitle)}</h3>
          <div class="reqs-grid">
            <div class="req-row"><strong>${esc(t.reqOs)}</strong> <span style="color:var(--text-muted);text-align:end;">${esc(pickText(item.requirements?.os, state.lang) || 'Multi-Platform')}</span></div>
            ${item.requirements?.cpu ? `<div class="req-row"><strong>CPU:</strong> <span class="mono">${esc(item.requirements.cpu)}</span></div>` : ''}
            <div class="req-row"><strong>${esc(t.reqRam)}</strong> <span class="mono">${esc(item.requirements?.ram || '2 GB RAM')}</span></div>
            ${item.requirements?.gpu ? `<div class="req-row"><strong>GPU:</strong> <span class="mono">${esc(item.requirements.gpu)}</span></div>` : ''}
            <div class="req-row"><strong>${esc(t.reqDisk)}</strong> <span class="mono">${esc(item.requirements?.disk || '100 MB')}</span></div>
            <div class="req-row"><strong>${esc(t.reqArch)}</strong> <span class="mono">${esc(item.requirements?.arch || 'x64 / ARM64')}</span></div>
          </div>
        </div>
      </div>

      <div id="platformMatrixAnchor">
        <h2 class="section-title">${esc(t.matrixTitle)}</h2>
        <p class="section-sub">${esc(t.matrixSub)}</p>

        <div class="matrix-grid">
          ${availPlatforms.map(pKey => {
            const p = item.platforms[pKey];
            const isRec = pKey === state.visitorOS;
            const dlCount = item.stats?.downloads?.[pKey] || 0;
            const dlPath = p.externalUrl || p.url || `/api/download/${item.slug}/${pKey}`;
            return `
              <div class="plat-card ${isRec ? 'recommended' : ''}">
                <div style="display:flex;flex-direction:column;gap:12px;">
                  ${isRec ? `<span class="rec-ribbon">★ ${esc(t.recommendedBadge)}</span>` : ''}
                  <div class="plat-card-head">
                    <div class="plat-name-wrap">
                      ${ICONS[pKey]}
                      <span>${esc(t.platforms[pKey])}</span>
                    </div>
                    <span class="mono" style="font-size:0.78rem;color:var(--accent-emerald);font-weight:700;">${esc(p.version || item.version)}</span>
                  </div>

                  <div class="plat-meta-list">
                    <div><strong>${esc(t.archLabel)}</strong> ${esc(p.arch || '—')}</div>
                    <div><strong>${esc(t.formatLabel)}</strong> <span class="mono">${esc(p.format || '—')}</span></div>
                    <div><strong>${esc(t.sizeLabel)}</strong> <span class="mono">${esc(p.size || '—')}</span></div>
                    <div><strong>${esc(t.dlCountLabel)}</strong> <span class="mono" data-dl-num="${esc(item.slug)}:${pKey}">${dlCount.toLocaleString()}</span></div>
                  </div>
                  ${pickText(p.notes, state.lang) ? `<p style="font-size:0.83rem;color:var(--text-muted);">${esc(pickText(p.notes, state.lang))}</p>` : ''}
                </div>

                <div style="display:flex;flex-direction:column;gap:8px;">
                  ${p.sha256 ? `<div class="sha-box" title="SHA-256: ${esc(p.sha256)}">SHA-256: ${esc(p.sha256)}</div>` : ''}
                  <div style="display:grid;grid-template-columns:1.35fr 0.85fr auto;gap:8px;">
                    <a href="${esc(dlPath)}"
                       class="btn ${isRec ? 'primary' : ''}"
                       data-dl-track="${esc(item.slug)}:${pKey}">${esc(t.downloadBtn)}</a>
                    <button type="button" class="btn" data-qr-dl="${esc(dlPath)}" data-qr-label="${esc(t.platforms[pKey])}">${esc(t.qrBtn)}</button>
                    ${p.sha256 ? `<button type="button" class="btn" data-copy-sha="${esc(p.sha256)}" title="${esc(t.copySha)}">SHA</button>` : ''}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        ${Array.isArray(item.extraLinks) && item.extraLinks.length > 0 ? `
          <div class="info-panel" style="margin-top:20px;">
            <h3>🔗 ${state.lang === 'ar' ? 'نسخ وروابط تحميل إضافية' : 'Additional Mirrors & Downloads'}</h3>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;">
              ${item.extraLinks.map(ex => `
                <a href="${esc(ex.url)}" target="_blank" rel="noopener" class="btn" style="justify-content:space-between;">
                  <span>${esc(ex.label)}</span>
                  <span class="mono" style="color:var(--text-muted);font-size:0.8rem;">${esc(ex.size || '↗')}</span>
                </a>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      ${renderShaVerifierWidget()}
      <div id="detailReviewsBox"></div>
    </section>
  `;

  wireShaVerifier(item);
  mountReviewsWidget('detailReviewsBox', item.slug);

  root.querySelectorAll('[data-thumb-src]').forEach(thumb => {
    thumb.onclick = () => {
      const mainImg = document.getElementById('mainDetailImg');
      const src = thumb.getAttribute('data-thumb-src');
      if (mainImg && src) {
        mainImg.src = src;
        mainImg.setAttribute('data-zoom-img', src);
      }
    };
  });

  root.querySelectorAll('[data-zoom-img]').forEach(el => {
    el.onclick = () => {
      openUtilityModal(
        pickText(item.title, state.lang),
        `<img src="${esc(el.getAttribute('data-zoom-img'))}" alt="" style="max-width:100%;max-height:74vh;border-radius:12px;" />`
      );
    };
  });

  const showQrForPath = (relOrAbs, platTitle) => {
    const fullUrl = /^https?:\/\//i.test(relOrAbs) ? relOrAbs : `${window.location.origin}${relOrAbs}`;
    openUtilityModal(
      `${t.qrModalTitle} — ${platTitle}`,
      `
        <div style="background:#FFF;padding:16px;border-radius:16px;display:inline-block;">
          ${renderQrSvg(fullUrl, 200)}
        </div>
        <p style="font-size:0.84rem;color:var(--text-muted);max-width:44ch;">${esc(t.qrModalTorHint)}</p>
      `
    );
  };

  if (best) {
    document.getElementById('heroQrBtn')?.addEventListener('click', () => {
      const target = best.info.externalUrl || `/api/download/${item.slug}/${best.key}`;
      showQrForPath(target, t.platforms[best.key]);
    });
  }

  root.querySelectorAll('[data-qr-dl]').forEach(btn => {
    btn.onclick = () => showQrForPath(btn.getAttribute('data-qr-dl'), btn.getAttribute('data-qr-label'));
  });

  root.querySelectorAll('[data-copy-sha]').forEach(btn => {
    btn.onclick = () => copyText(btn.getAttribute('data-copy-sha'));
  });

  wireDownloadCounters(root);
}

// ================= ARTICLE / POST READER VIEW =================

function renderPostView(root) {
  const t = DICT[state.lang];
  const post = state.posts.find(x => x.slug === state.route.slug);
  if (!post) {
    window.location.hash = '#vault';
    return;
  }

  fetch(`/api/posts/${encodeURIComponent(post.slug)}/view`, { method: 'POST' }).catch(() => {});
  const linkedItem = post.linkedProject ? state.catalog.find(x => x.slug === post.linkedProject) : null;

  root.innerHTML = `
    <article class="detail-view" style="max-width:900px;margin-inline:auto;">
      <div class="detail-topbar">
        <a href="#topicsAnchor" class="btn">${esc(t.backToVault)}</a>
        <span style="font-size:0.84rem;color:var(--text-muted);">${esc(post.date)} • ${esc(post.author || '')}</span>
      </div>

      <div class="info-panel" style="padding:32px;">
        <span class="eyebrow-tag">${esc(pickText(post.topicType, state.lang))}</span>
        <h1 class="detail-title" style="margin-top:14px;">${esc(pickText(post.title, state.lang))}</h1>
        <p style="color:var(--text-muted);font-size:1.04rem;margin-block:12px 22px;">${esc(pickText(post.summary, state.lang))}</p>

        ${post.cover ? `<img src="${esc(post.cover)}" alt="" style="width:100%;max-height:400px;object-fit:cover;border-radius:var(--radius-lg);margin-bottom:24px;" />` : ''}

        <div style="font-size:1.02rem;line-height:1.85;">
          ${renderSimpleMarkdown(pickText(post.content, state.lang))}
        </div>

        ${linkedItem ? `
          <div style="margin-top:28px;padding:18px;background:var(--bg-panel-alt);border-radius:var(--radius-md);border:1px solid var(--border-base);display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;">
            <div>
              <div style="font-size:0.78rem;color:var(--text-muted);">${state.lang === 'ar' ? 'التطبيق المرتبط بالمقال' : 'Related Software'}</div>
              <strong style="font-size:1.1rem;">${esc(pickText(linkedItem.title, state.lang))} (${esc(linkedItem.version)})</strong>
            </div>
            <a href="#project/${esc(linkedItem.slug)}" class="btn primary">${esc(t.openStorePage)}</a>
          </div>
        ` : ''}
      </div>

      <div id="postReviewsBox"></div>
    </article>
  `;

  mountReviewsWidget('postReviewsBox', `post-${post.slug}`);
}

function wireDownloadCounters(container) {
  container.querySelectorAll('[data-dl-track]').forEach(link => {
    link.addEventListener('click', () => {
      const [slug, plat] = link.getAttribute('data-dl-track').split(':');
      const item = state.catalog.find(x => x.slug === slug);
      if (item && item.stats) {
        item.stats.downloads[plat] = (item.stats.downloads[plat] || 0) + 1;
        item.stats.totalDownloads = (item.stats.totalDownloads || 0) + 1;
        const badge = container.querySelector(`[data-dl-num="${slug}:${plat}"]`);
        if (badge) badge.textContent = item.stats.downloads[plat].toLocaleString();
      }
    });
  });
}

function renderFooter() {
  const t = DICT[state.lang];
  const cfg = state.siteConfig || {};
  // the admin can override both lines from the CPanel; fall back to the old wording
  const rights = (pickText(cfg.footerRights, state.lang) || '').trim() || t.footerRights;
  const note = (pickText(cfg.footerNote, state.lang) || '').trim();
  // year 0 = "don't print a year at all"
  const yearSetting = cfg.footerYear;
  const year = (yearSetting === 0 || yearSetting === 'none')
    ? ''
    : String(yearSetting && Number(yearSetting) > 1900 ? yearSetting : new Date().getFullYear());
  const brand = pickText(cfg.title, state.lang) || '';
  const rightsLine = esc(rights).replace(/\{year\}/g, year).replace(/\{name\}/g, esc(brand));

  document.getElementById('footerContainer').innerHTML = `
    <div class="footer-main">
      <span class="footer-brand">${esc(brand)}${year ? ` © ${year}` : ''}</span>
      ${rightsLine ? `<span class="footer-rights"> — ${rightsLine}</span>` : ''}
    </div>
    <div class="footer-side">
      ${note ? `<span class="footer-note">${esc(note)}</span>` : ''}
      ${state.torOnion ? `
        <button type="button" class="btn ghost" id="copyTorFooterBtn" style="font-size:0.8rem;color:var(--accent-tor);">
          🧅 ${esc(t.torFooterBadge)}
        </button>
      ` : ''}
    </div>
  `;

  document.getElementById('copyTorFooterBtn')?.addEventListener('click', () => {
    copyText(`http://${state.torOnion}`);
  });
}

function renderAll() {
  applyThemeAndLang();
  renderTickerBar();
  injectActivePlugins();
  renderAdminTopBar();
  renderHeader();
  const root = document.getElementById('appRoot');
  if (state.route.view === 'detail') renderDetailView(root);
  else if (state.route.view === 'post') renderPostView(root);
  else renderHomeView(root);
  renderFooter();
}

window.addEventListener('hashchange', () => {
  parseHash();
  window.scrollTo({ top: 0, behavior: 'instant' });
  renderAll();
});

(async () => {
  parseHash();
  await fetchBootstrap();
  renderAll();
})();
