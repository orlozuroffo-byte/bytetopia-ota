const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');
const otaEngine = require('./ota-engine');

const app = express();
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bytetopia2026';
const DESKTOP_AUTO_KEY = process.env.BYTETOPIA_DESKTOP_KEY || process.env.ODDWARE_DESKTOP_KEY || '';

// Support standard repo paths, portable server bundles, Docker/CasaOS volumes, .AppImage, and OTA Live Overlays!
const BUNDLE_ROOT = process.env.BYTETOPIA_BUNDLE_ROOT || process.env.ODDWARE_BUNDLE_ROOT || path.resolve(__dirname, '..');
const ACTIVE_ROOT = process.env.BYTETOPIA_ACTIVE_ROOT || process.env.ODDWARE_ACTIVE_ROOT || path.resolve(__dirname, '..');
const ROOT_DIR = BUNDLE_ROOT;
const SEED_DATA_DIR = path.join(BUNDLE_ROOT, 'seed-data');
const PUBLIC_DIR = process.env.BYTETOPIA_LIVE_PUBLIC_DIR || process.env.ODDWARE_LIVE_PUBLIC_DIR || process.env.BYTETOPIA_PUBLIC_DIR || process.env.ODDWARE_PUBLIC_DIR || path.join(ACTIVE_ROOT, 'public');

const DATA_DIR = process.env.BYTETOPIA_DATA_DIR || process.env.ODDWARE_DATA_DIR || path.join(BUNDLE_ROOT, 'data');
const LIVE_APP_DIR = path.join(DATA_DIR, 'live-app');
// When an OTA overlay exists, serve its public/ so updates go live without a package.
const EFFECTIVE_PUBLIC_DIR = fs.existsSync(path.join(LIVE_APP_DIR, 'public', 'index.html'))
  ? path.join(LIVE_APP_DIR, 'public')
  : PUBLIC_DIR;
const LIVE_APP_PREV_DIR = path.join(DATA_DIR, 'live-app.prev');
const CATALOG_DIR = path.join(DATA_DIR, 'catalog');
const OVERLAY_CATALOG_DIR = path.join(LIVE_APP_DIR, 'data', 'catalog');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const TOR_KEYS_DIR = path.join(DATA_DIR, 'tor-keys');
const STORAGE_DIR = process.env.BYTETOPIA_STORAGE_DIR || process.env.ODDWARE_STORAGE_DIR || path.join(BUNDLE_ROOT, 'storage');
const RELEASES_DIR = path.join(STORAGE_DIR, 'releases');
const WEB_BUILDS_DIR = path.join(STORAGE_DIR, 'web-builds');
const MEDIA_UPLOADS_DIR = process.env.BYTETOPIA_MEDIA_DIR || process.env.ODDWARE_MEDIA_DIR || path.join(STORAGE_DIR, 'media');

[DATA_DIR, CATALOG_DIR, POSTS_DIR, TOR_KEYS_DIR, RELEASES_DIR, WEB_BUILDS_DIR, MEDIA_UPLOADS_DIR].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// Auto-seed DATA_DIR when mounting an empty Docker / CasaOS host volume onto /app/data!
function copyRecursiveMissing(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursiveMissing(sPath, dPath);
    else if (!fs.existsSync(dPath)) fs.copyFileSync(sPath, dPath);
  }
}
if (!fs.existsSync(path.join(DATA_DIR, 'site-config.json')) && fs.existsSync(SEED_DATA_DIR)) {
  console.log(`[BYTETOPIA SEED] Initializing empty data volume ${DATA_DIR} from ${SEED_DATA_DIR}...`);
  copyRecursiveMissing(SEED_DATA_DIR, DATA_DIR);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

// ================= HELPERS =================

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonPretty(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const AR_TRANSLIT = {
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'aa', 'ب': 'b', 'ت': 't', 'ث': 'th',
  'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z',
  'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a',
  'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'ة': 'a', 'و': 'w', 'ؤ': 'u', 'ي': 'y', 'ى': 'a', 'ئ': 'y'
};

function sanitizeSlug(str) {
  const transliterated = Array.from(String(str || '').toLowerCase())
    .map(ch => (AR_TRANSLIT[ch] !== undefined ? AR_TRANSLIT[ch] : ch))
    .join('');
  return transliterated
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// User-editable config lives in DATA_DIR and MUST always win, because that is
// exactly where the CPanel writes it. OTA overlays only ever provide *catalog*
// defaults, never the user's own settings — otherwise every CPanel change would
// be silently reverted on the next read (the "changes don't save" bug).
function readUserDataJson(relPath, fallbackDefault) {
  // relPath is DATA_DIR-relative, e.g. 'site-config.json'
  return readJsonSafe(path.join(DATA_DIR, relPath), fallbackDefault);
}

function readOverlayOrDefault(relPath, fallbackDefault) {
  const overlayRel = relPath.replace(/^data\//, '');
  const overlayPath = path.join(LIVE_APP_DIR, overlayRel);
  if (fs.existsSync(overlayPath)) {
    const fromOverlay = readJsonSafe(overlayPath, null);
    if (fromOverlay !== null && Object.keys(fromOverlay).length) return fromOverlay;
  }
  return readJsonSafe(path.join(DATA_DIR, relPath), fallbackDefault);
}

function readSiteConfig() {
  // Always the user's live copy in DATA_DIR — never the overlay, never the bundle.
  const own = readUserDataJson('site-config.json', null);
  if (own && Object.keys(own).length) return own;
  // First run on a fresh volume: seed from the bundled defaults once, then it's theirs.
  return readJsonSafe(path.join(SEED_DATA_DIR, 'site-config.json'),
    readJsonSafe(path.join(BUNDLE_ROOT, 'data', 'site-config.json'), {}));
}

function readCategories() {
  return readJsonSafe(path.join(DATA_DIR, 'categories.json'), []);
}

function readPlugins() {
  return readJsonSafe(path.join(DATA_DIR, 'plugins.json'), []);
}

function readReviews() {
  return readJsonSafe(path.join(DATA_DIR, 'reviews.json'), {});
}

function readTelemetry() {
  return readJsonSafe(path.join(DATA_DIR, 'telemetry.json'), {});
}

function saveTelemetry(t) {
  writeJsonPretty(path.join(DATA_DIR, 'telemetry.json'), t);
}

// ================= NATIVE TOR (.ONION) & CLOUDFLARE DAEMON ENGINE =================

const daemonState = {
  managedExternally: process.env.BYTETOPIA_MANAGED_DAEMONS === '1' || process.env.ODDWARE_MANAGED_DAEMONS === '1',
  torProc: null,
  torBin: '',
  torRunning: false,
  torBootstrap: 0,
  torOnion: '',
  torWorkDir: '',
  torWatcher: null,
  cfProc: null,
  cfBin: '',
  cfRunning: false,
  cfUrl: '',
  logs: []
};

function pushDaemonLog(line) {
  const clean = String(line || '').trim();
  if (!clean) return;
  daemonState.logs.push(`${new Date().toISOString().slice(11, 19)} ${clean}`);
  if (daemonState.logs.length > 120) daemonState.logs.shift();
}

function findExecutable(name, candidates) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) {}
  }
  try {
    const resolved = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (resolved) return resolved;
  } catch (_) {}
  return '';
}

function resolveTorBinary() {
  return findExecutable('tor', [
    process.env.BYTETOPIA_TOR_BIN || process.env.ODDWARE_TOR_BIN,
    path.join(ROOT_DIR, 'runtime', 'tor', 'tor'),
    '/usr/bin/tor',
    '/usr/sbin/tor',
    '/usr/local/bin/tor',
    '/bin/tor'
  ]);
}

function resolveCloudflaredBinary() {
  return findExecutable('cloudflared', [
    process.env.BYTETOPIA_CLOUDFLARED_BIN || process.env.ODDWARE_CLOUDFLARED_BIN,
    path.join(ROOT_DIR, 'runtime', 'bin', 'cloudflared'),
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/bin/cloudflared'
  ]);
}

function stopManagedTor() {
  if (daemonState.torWatcher) {
    clearInterval(daemonState.torWatcher);
    daemonState.torWatcher = null;
  }
  if (daemonState.torProc) {
    try { daemonState.torProc.kill('SIGTERM'); } catch (_) {}
    daemonState.torProc = null;
  }
  daemonState.torRunning = false;
}

function startManagedTor({ rotateKeys = false } = {}) {
  if (daemonState.managedExternally || process.env.AUTO_TOR === '0' || process.env.BYTETOPIA_EXTERNAL_TOR === '1' || process.env.ODDWARE_EXTERNAL_TOR === '1') {
    return { started: false, reason: 'external_or_disabled' };
  }
  stopManagedTor();

  const torBin = resolveTorBinary();
  daemonState.torBin = torBin;
  if (!torBin) {
    pushDaemonLog('[TOR] tor binary not found on system or runtime/tor.');
    return { started: false, reason: 'tor_binary_missing' };
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const workDir = path.join(os.tmpdir(), `bytetopia-tor-${PORT}-${uid}`);
  const dataDir = path.join(workDir, 'data');
  const hsDir = path.join(workDir, 'hs');
  daemonState.torWorkDir = workDir;

  if (rotateKeys) {
    try { fs.rmSync(TOR_KEYS_DIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(hsDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(path.join(DATA_DIR, 'runtime-tor-hostname')); } catch (_) {}
    daemonState.torOnion = '';
  }

  fs.mkdirSync(TOR_KEYS_DIR, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(hsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(workDir, 0o700);
  fs.chmodSync(dataDir, 0o700);
  fs.chmodSync(hsDir, 0o700);

  // Restore persistent .onion keys into strict 0700 tmpfs/rootfs HS folder (immune to Docker bind-mount chmod limits!)
  for (const keyName of ['hs_ed25519_secret_key', 'hs_ed25519_public_key', 'hostname']) {
    const savedKey = path.join(TOR_KEYS_DIR, keyName);
    const liveKey = path.join(hsDir, keyName);
    if (fs.existsSync(savedKey) && !fs.existsSync(liveKey)) {
      fs.copyFileSync(savedKey, liveKey);
      fs.chmodSync(liveKey, 0o600);
    }
  }

  const torDir = path.dirname(torBin);
  const torrcLines = [
    'SocksPort 0',
    `DataDirectory ${dataDir}`,
    `HiddenServiceDir ${hsDir}`,
    'HiddenServiceVersion 3',
    `HiddenServicePort 80 127.0.0.1:${PORT}`,
    'Log notice stdout'
  ];
  const bundledGeoIp = path.join(torDir, 'data', 'geoip');
  const bundledGeoIp6 = path.join(torDir, 'data', 'geoip6');
  if (fs.existsSync(bundledGeoIp)) torrcLines.push(`GeoIPFile ${bundledGeoIp}`);
  if (fs.existsSync(bundledGeoIp6)) torrcLines.push(`GeoIPv6File ${bundledGeoIp6}`);

  const torrcPath = path.join(workDir, 'torrc');
  fs.writeFileSync(torrcPath, torrcLines.join('\n') + '\n', 'utf8');

  const env = { ...process.env };
  if (torDir.includes(path.join('runtime', 'tor'))) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${torDir}:${env.LD_LIBRARY_PATH}` : torDir;
  }

  daemonState.torBootstrap = 5;
  pushDaemonLog(`[TOR] Starting Hidden Service using ${torBin}...`);
  const proc = spawn(torBin, ['-f', torrcPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemonState.torProc = proc;
  daemonState.torRunning = true;

  const onTorLine = chunk => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/Bootstrapped\s+(\d+)%/i);
      if (m) {
        daemonState.torBootstrap = Number(m[1]);
        pushDaemonLog(`[TOR] Bootstrapped ${daemonState.torBootstrap}%`);
      } else if (/err|warn/i.test(line)) {
        pushDaemonLog(`[TOR] ${line.trim()}`);
      }
    }
  };
  proc.stdout.on('data', onTorLine);
  proc.stderr.on('data', onTorLine);
  proc.on('exit', code => {
    daemonState.torRunning = false;
    pushDaemonLog(`[TOR] Process exited (code=${code})`);
  });

  const syncOnionHostname = () => {
    const hFile = path.join(hsDir, 'hostname');
    try {
      if (fs.existsSync(hFile)) {
        const host = fs.readFileSync(hFile, 'utf8').trim();
        if (host && host.endsWith('.onion')) {
          if (daemonState.torOnion !== host) {
            daemonState.torOnion = host;
            fs.writeFileSync(path.join(DATA_DIR, 'runtime-tor-hostname'), `${host}\n`, 'utf8');
            for (const keyName of ['hs_ed25519_secret_key', 'hs_ed25519_public_key', 'hostname']) {
              const liveKey = path.join(hsDir, keyName);
              if (fs.existsSync(liveKey)) {
                fs.copyFileSync(liveKey, path.join(TOR_KEYS_DIR, keyName));
              }
            }
            console.log(`[BYTETOPIA TOR] Live Hidden Service (.onion): http://${host}`);
            pushDaemonLog(`[TOR] Active .onion -> http://${host}`);
          }
        }
      }
    } catch (_) {}
  };
  syncOnionHostname();
  daemonState.torWatcher = setInterval(syncOnionHostname, 1000);
  return { started: true, torBin };
}

function stopManagedCloudflared() {
  if (daemonState.cfProc) {
    try { daemonState.cfProc.kill('SIGTERM'); } catch (_) {}
    daemonState.cfProc = null;
  }
  daemonState.cfRunning = false;
}

function startManagedCloudflared() {
  if (daemonState.managedExternally || process.env.AUTO_CLOUDFLARE === '0' || process.env.BYTETOPIA_EXTERNAL_CF === '1' || process.env.ODDWARE_EXTERNAL_CF === '1') {
    return { started: false, reason: 'external_or_disabled' };
  }
  stopManagedCloudflared();

  const cfBin = resolveCloudflaredBinary();
  daemonState.cfBin = cfBin;
  if (!cfBin) {
    pushDaemonLog('[CLOUDFLARE] cloudflared binary not found.');
    return { started: false, reason: 'cloudflared_binary_missing' };
  }

  try { fs.unlinkSync(path.join(DATA_DIR, 'runtime-cf-url')); } catch (_) {}
  daemonState.cfUrl = '';

  const token = (process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
  const args = token
    ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];

  pushDaemonLog(`[CLOUDFLARE] Starting tunnel via ${cfBin}...`);
  const proc = spawn(cfBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  daemonState.cfProc = proc;
  daemonState.cfRunning = true;

  const onCfData = chunk => {
    const text = chunk.toString('utf8');
    const matches = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    if (matches && matches.length > 0) {
      const url = matches[matches.length - 1];
      if (daemonState.cfUrl !== url) {
        daemonState.cfUrl = url;
        fs.writeFileSync(path.join(DATA_DIR, 'runtime-cf-url'), `${url}\n`, 'utf8');
        console.log(`[BYTETOPIA CLOUDFLARE] Live HTTPS Tunnel: ${url}`);
        pushDaemonLog(`[CLOUDFLARE] Active URL -> ${url}`);
      }
    }
  };
  proc.stdout.on('data', onCfData);
  proc.stderr.on('data', onCfData);
  proc.on('exit', code => {
    daemonState.cfRunning = false;
    pushDaemonLog(`[CLOUDFLARE] Process exited (code=${code})`);
  });
  return { started: true, cfBin };
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopManagedTor();
    stopManagedCloudflared();
    process.exit(0);
  });
}

function getTorOnionStatus() {
  if (daemonState.torOnion && daemonState.torOnion.endsWith('.onion')) {
    return {
      onionHost: daemonState.torOnion,
      liveFromContainer: true,
      bootstrap: daemonState.torBootstrap,
      running: daemonState.torRunning
    };
  }
  const candidates = [
    process.env.TOR_HOSTNAME_FILE || '/run/tor-info/hostname',
    path.join(DATA_DIR, 'runtime-tor-hostname'),
    path.join(TOR_KEYS_DIR, 'hostname'),
    path.join(ROOT_DIR, 'tor-data', 'hostname')
  ];
  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (raw && raw.endsWith('.onion')) {
          return {
            onionHost: raw,
            liveFromContainer: true,
            bootstrap: daemonState.torBootstrap || 100,
            running: daemonState.torRunning || true
          };
        }
      }
    } catch (_) {}
  }
  const cfg = readSiteConfig();
  return {
    onionHost: process.env.TOR_ONION_HOST || cfg?.network?.customOnionFallback || '',
    liveFromContainer: false,
    bootstrap: daemonState.torBootstrap || 0,
    running: daemonState.torRunning
  };
}

function getCloudflareUrl(cfg) {
  if (process.env.CLOUDFLARE_PUBLIC_URL) return process.env.CLOUDFLARE_PUBLIC_URL;
  if (daemonState.cfUrl) return daemonState.cfUrl;
  const candidates = [
    process.env.CF_LOG_FILE || '/run/cf-info/tunnel.log',
    path.join(DATA_DIR, 'runtime-cf-url')
  ];
  for (const f of candidates) {
    try {
      if (f && fs.existsSync(f)) {
        const content = fs.readFileSync(f, 'utf8');
        const matches = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
        if (matches && matches.length > 0) return matches[matches.length - 1];
      }
    } catch (_) {}
  }
  return cfg?.network?.cloudflareUrl || '';
}

// ================= ACCOUNTS, SESSIONS & FIRST-USER-CLAIMS-ADMIN AUTH =================

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function readUsers() {
  const arr = readJsonSafe(USERS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function saveUsers(users) {
  writeJsonPretty(USERS_FILE, users);
}

function readSessions() {
  const obj = readJsonSafe(SESSIONS_FILE, {});
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}

function saveSessions(sessions) {
  writeJsonPretty(SESSIONS_FILE, sessions);
}

function hashUserPassword(pwd, salt) {
  return crypto.scryptSync(String(pwd || ''), `bytetopia-v3.1::${salt}`, 48).toString('hex');
}

function verifyUserPassword(pwd, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const candidate = hashUserPassword(pwd, user.salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'));
  } catch (_) {
    return false;
  }
}

function sanitizePublicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role || 'member',
    isOwner: Boolean(u.isOwner),
    createdAt: u.createdAt
  };
}

function normalizeUsername(raw) {
  return String(raw || '').trim().slice(0, 40);
}

function isValidUsernameFormat(uname) {
  if (!uname || uname.length < 2 || uname.length > 40) return false;
  return /^[\p{L}\p{N}_.\-]+$/u.test(uname);
}

function hasAnyAdminUser() {
  return readUsers().some(u => u.role === 'admin');
}

function createSessionForUser(userId) {
  const sessions = readSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = {
    userId,
    createdAt: Date.now()
  };
  // Prune sessions older than 60 days
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  for (const [tk, info] of Object.entries(sessions)) {
    if (!info || (info.createdAt || 0) < cutoff) delete sessions[tk];
  }
  saveSessions(sessions);
  return token;
}

function extractRequestToken(req) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return String(
    req.headers['x-session-token'] ||
    req.headers['x-admin-token'] ||
    req.headers['x-admin-key'] ||
    req.query.token ||
    ''
  ).trim();
}

function getRequestUser(req) {
  const token = extractRequestToken(req);
  if (!token) return null;
  if (DESKTOP_AUTO_KEY && token === DESKTOP_AUTO_KEY) {
    return readUsers().find(u => u.role === 'admin') || {
      id: 'desktop-host',
      username: 'studio-owner',
      displayName: 'Studio Host',
      role: 'admin',
      isOwner: true
    };
  }
  const sessions = readSessions();
  const sess = sessions[token];
  if (!sess || !sess.userId) return null;
  const users = readUsers();
  return users.find(u => u.id === sess.userId) || null;
}

function requireAdmin(req, res, next) {
  const user = getRequestUser(req);
  if (!user) {
    return res.status(401).json({ error: 'UNAUTHORIZED_PLEASE_LOGIN' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN_ADMIN_ONLY' });
  }
  req.adminUser = user;
  next();
}

// ================= DATA READERS =================

// Fields the CPanel owns per app. When an OTA overlay ships a newer copy of an
// app manifest, these are carried over from the user's version so an update can
// change published content without silently reverting an admin's edit.
const CATALOG_USER_OWNED_KEYS = ['status', 'featured'];

/**
 * Merges an overlay (OTA-delivered) catalog entry onto the user's local copy.
 * The overlay wins for published content — that is the whole point of shipping
 * a content update — while CPanel-owned flags stay with the user.
 */
function mergeOverlayCatalogItem(local, overlay) {
  if (!local) return overlay;
  const merged = { ...local, ...overlay };
  for (const key of CATALOG_USER_OWNED_KEYS) {
    if (local[key] !== undefined) merged[key] = local[key];
  }
  // Never let an update swap the slug out from under the local filename.
  merged.slug = local.slug || overlay.slug;
  return merged;
}

function readCatalogAll(includeDrafts = false) {
  const telemetry = readTelemetry();
  const reviews = readReviews();
  // The storefront reads two sources:
  //   1. CATALOG_DIR         — the user's own data/catalog (CPanel edits land here)
  //   2. OVERLAY_CATALOG_DIR — live-app/data/catalog (what an OTA update ships)
  //
  // The overlay wins on published content, otherwise an over-the-air content
  // update would download and stage successfully and the storefront would keep
  // showing the old copy — which is exactly what used to happen. A small set of
  // CPanel-owned flags is preserved from the local file instead.
  const localByFile = new Map();
  const overlayByFile = new Map();
  const scan = (dir, into) => {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch (_) { return; }
    for (const file of names) if (!into.has(file)) into.set(file, path.join(dir, file));
  };
  scan(CATALOG_DIR, localByFile);
  if (OVERLAY_CATALOG_DIR !== CATALOG_DIR) scan(OVERLAY_CATALOG_DIR, overlayByFile);

  // An OTA update can also RETIRE an app: it stops shipping the file, but the
  // user's own data/catalog copy stays on disk forever and the storefront keeps
  // listing it. Detect that precisely instead of guessing.
  //
  // A file counts as retired only when all three hold:
  //   1. it exists in the user's data/catalog,
  //   2. the update that is now live no longer ships it,
  //   3. an EARLIER update did ship it.
  // Condition 3 is what protects apps the user created in the CPanel: those were
  // never part of a shipped manifest, so they can never be mistaken for retired.
  const readShippedCatalogPaths = (dir) => {
    try {
      const m = readJsonSafe(path.join(dir, 'ota-manifest.json'), null);
      if (!m || !m.files) return null;
      const set = new Set();
      for (const rel of Object.keys(m.files)) {
        if (rel.startsWith('data/catalog/') && rel.endsWith('.json')) {
          set.add(path.basename(rel));
        }
      }
      return set;
    } catch (_) { return null; }
  };
  const shippedNow = readShippedCatalogPaths(LIVE_APP_DIR);
  // Fall back to the bundle root for the "before" side on the very first update
  // after a fresh install, where no overlay has existed yet.
  let shippedBefore = readShippedCatalogPaths(LIVE_APP_PREV_DIR);
  if (!shippedBefore) shippedBefore = readShippedCatalogPaths(BUNDLE_ROOT);
  const retired = new Set();
  if (shippedNow && shippedBefore) {
    for (const file of localByFile.keys()) {
      if (!shippedNow.has(file) && shippedBefore.has(file)) retired.add(file);
    }
  }

  const allFiles = new Set([...localByFile.keys(), ...overlayByFile.keys()]);
  for (const file of retired) allFiles.delete(file);
  const list = [];
  for (const file of allFiles) {
    const localPath = localByFile.get(file);
    const overlayPath = overlayByFile.get(file);
    const localItem = localPath ? readJsonSafe(localPath, null) : null;
    const overlayItem = overlayPath ? readJsonSafe(overlayPath, null) : null;
    let item = localItem;
    if (overlayItem && overlayItem.slug) {
      item = localItem && localItem.slug
        ? mergeOverlayCatalogItem(localItem, overlayItem)
        : overlayItem;
    }
    if (!item || !item.slug) continue;
    if (!includeDrafts && item.status === 'draft') continue;
    const t = telemetry[item.slug] || { downloads: {} };
    const dlByPlat = {
      windows: t.downloads?.windows || 0,
      linux: t.downloads?.linux || 0,
      macos: t.downloads?.macos || 0,
      xbox: t.downloads?.xbox || 0,
      android: t.downloads?.android || 0,
      ios: t.downloads?.ios || 0
    };
    const totalDownloads = Object.values(dlByPlat).reduce((a, b) => a + b, 0);
    const itemReviews = reviews[item.slug] || [];
    const avgRating = itemReviews.length
      ? Number((itemReviews.reduce((s, r) => s + Number(r.rating || 5), 0) / itemReviews.length).toFixed(1))
      : 0;
    list.push({
      ...item,
      stats: {
        downloads: dlByPlat,
        totalDownloads,
        reviewsCount: itemReviews.length,
        avgRating
      }
    });
  }
  return list.sort((a, b) => {
    if (Boolean(b.featured) !== Boolean(a.featured)) return b.featured ? 1 : -1;
    return String(a.code || a.slug).localeCompare(String(b.code || b.slug));
  });
}

function readPostsAll(includeDrafts = false) {
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  const posts = [];
  for (const file of files) {
    const post = readJsonSafe(path.join(POSTS_DIR, file), null);
    if (!post || !post.slug) continue;
    if (!includeDrafts && post.status === 'draft') continue;
    posts.push(post);
  }
  return posts.sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });
}

// ================= HEADERS & RATE SHIELD =================

const downloadHits = new Map();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token, X-Admin-Token');
  const tor = getTorOnionStatus();
  if (tor.onionHost && tor.liveFromContainer && !String(req.headers.host || '').endsWith('.onion')) {
    res.setHeader('Onion-Location', `http://${tor.onionHost}${req.originalUrl}`);
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const uploadTmp = multer({
  dest: path.join(os.tmpdir(), 'bytetopia-uploads'),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }
});

// ================= UNIFIED USER & FIRST-ADMIN AUTH ROUTES =================

app.get('/api/auth/me', (req, res) => {
  const siteConfig = readSiteConfig();
  const user = getRequestUser(req);
  res.json({
    authenticated: Boolean(user),
    user: sanitizePublicUser(user),
    hasAdmin: hasAnyAdminUser(),
    allowRegistration: siteConfig.allowPublicRegistration !== false
  });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password, displayName } = req.body || {};
  const cleanUser = normalizeUsername(username);
  const pwd = String(password || '');

  if (!isValidUsernameFormat(cleanUser)) {
    return res.status(400).json({ error: 'INVALID_USERNAME', message: 'اسم المستخدم يجب أن يكون بين حرفين و40 حرفاً (حروف، أرقام، - أو _ أو .)' });
  }
  if (pwd.length < 4) {
    return res.status(400).json({ error: 'PASSWORD_TOO_SHORT', message: 'كلمة المرور يجب أن تكون 4 أحرف أو أكثر' });
  }

  const users = readUsers();
  const siteConfig = readSiteConfig();
  const isFirstAccount = users.length === 0;

  if (!isFirstAccount && siteConfig.allowPublicRegistration === false) {
    return res.status(403).json({ error: 'REGISTRATION_CLOSED', message: 'التسجيل العام متوقف حالياً من قِبل الإدارة' });
  }

  const exists = users.find(u => String(u.username || '').toLowerCase() === cleanUser.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'اسم المستخدم مسجّل بالفعل، اختر اسماً آخر أو سجّل الدخول' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const newUser = {
    id: `usr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    username: cleanUser,
    displayName: String(displayName || cleanUser).trim().slice(0, 50) || cleanUser,
    role: isFirstAccount ? 'admin' : 'member',
    isOwner: isFirstAccount,
    salt,
    passwordHash: hashUserPassword(pwd, salt),
    createdAt: new Date().toISOString().slice(0, 10)
  };

  users.push(newUser);
  saveUsers(users);

  const token = createSessionForUser(newUser.id);
  res.json({
    ok: true,
    token,
    user: sanitizePublicUser(newUser),
    isFirstAdmin: isFirstAccount
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, desktopKey } = req.body || {};
  if (DESKTOP_AUTO_KEY && desktopKey === DESKTOP_AUTO_KEY) {
    const user = getRequestUser({ headers: { 'x-admin-token': DESKTOP_AUTO_KEY }, query: {} });
    return res.json({ ok: true, token: DESKTOP_AUTO_KEY, user: sanitizePublicUser(user), hasAdmin: hasAnyAdminUser() });
  }

  const cleanUser = normalizeUsername(username);
  const pwd = String(password || '');
  const users = readUsers();

  if (users.length === 0) {
    return res.status(404).json({
      error: 'NO_ACCOUNTS_YET',
      message: 'لم يتم إنشاء أي حساب بعد! أنشئ حسابك الأول الآن ليمتلك صلاحية الإدارة تلقائياً.'
    });
  }

  const found = users.find(u => String(u.username || '').toLowerCase() === cleanUser.toLowerCase());
  if (!found || !verifyUserPassword(pwd, found)) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = createSessionForUser(found.id);
  res.json({
    ok: true,
    token,
    user: sanitizePublicUser(found)
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractRequestToken(req);
  if (token) {
    const sessions = readSessions();
    if (sessions[token]) {
      delete sessions[token];
      saveSessions(sessions);
    }
  }
  res.json({ ok: true });
});

// ================= PUBLIC STOREFRONT & TOPICS API (100% VISITOR-SAFE) =================


function clampLogoHeight(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 = auto responsive (CSS clamp)
  return Math.min(120, Math.max(24, Math.round(n)));
}

app.get('/api/bootstrap', (req, res) => {
  const rawConfig = readSiteConfig();
  const categories = readCategories();
  const plugins = readPlugins();
  const catalog = readCatalogAll(false);
  const posts = readPostsAll(false);
  const tor = getTorOnionStatus();
  const currentUser = getRequestUser(req);

  // Strip ALL internal server/LAN/hardware details from public visitor payload!
  const publicSiteConfig = {
    brandCode: rawConfig.brandCode || 'BT',
    logoUrl: rawConfig.logoUrl || '',
    logoHeight: clampLogoHeight(rawConfig.logoHeight),
    hideBrandText: Boolean(rawConfig.hideBrandText),
    siteTheme: rawConfig.siteTheme || 'modern_glass',
    showTicker: Boolean(rawConfig.showTicker),
    ticker: rawConfig.ticker || { ar: [], en: [] },
    title: rawConfig.title,
    subtitle: rawConfig.subtitle,
    // admin-editable wording: tagline beside the icon + footer lines
    headerTagline: rawConfig.headerTagline || { ar: '', en: '' },
    footerRights: rawConfig.footerRights || { ar: '', en: '' },
    footerNote: rawConfig.footerNote || { ar: '', en: '' },
    footerYear: rawConfig.footerYear === 0 ? 0 : 'auto',
    heroHeadline: rawConfig.heroHeadline,
    heroBio: rawConfig.heroBio,
    defaultLang: rawConfig.defaultLang || 'ar',
    defaultTheme: rawConfig.defaultTheme || 'dark',
    accentPreset: rawConfig.accentPreset || ''
  };

  const showTor = rawConfig?.network?.showTorBadge !== false && tor.liveFromContainer && tor.onionHost;

  res.json({
    siteConfig: publicSiteConfig,
    categories,
    plugins: plugins.filter(p => p.enabled),
    catalog,
    posts,
    auth: {
      hasAdmin: hasAnyAdminUser(),
      allowRegistration: rawConfig.allowPublicRegistration !== false,
      user: sanitizePublicUser(currentUser)
    },
    mirrors: {
      torOnion: showTor ? tor.onionHost : ''
    }
  });
});

app.post('/api/posts/:slug/view', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const pFile = path.join(POSTS_DIR, `${slug}.json`);
  if (!fs.existsSync(pFile)) return res.status(404).json({ error: 'POST_NOT_FOUND' });
  const post = readJsonSafe(pFile, {});
  post.views = (post.views || 0) + 1;
  writeJsonPretty(pFile, post);
  res.json({ ok: true, views: post.views });
});

app.get('/api/reviews/:slug', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const all = readReviews();
  res.json({ reviews: all[slug] || [] });
});

app.post('/api/reviews/:slug', (req, res) => {
  const plugins = readPlugins();
  const revPlugin = plugins.find(p => p.id === 'local-reviews');
  if (revPlugin && !revPlugin.enabled) {
    return res.status(403).json({ error: 'REVIEWS_PLUGIN_DISABLED' });
  }
  const slug = sanitizeSlug(req.params.slug);
  const { author, rating, comment } = req.body || {};
  const cleanComment = String(comment || '').trim().slice(0, 600);
  if (!cleanComment) return res.status(400).json({ error: 'EMPTY_COMMENT' });

  const sessionUser = getRequestUser(req);
  const resolvedAuthor = sessionUser
    ? (sessionUser.displayName || sessionUser.username)
    : (String(author || 'Visitor').trim().slice(0, 40) || 'Visitor');

  const all = readReviews();
  if (!all[slug]) all[slug] = [];
  const entry = {
    id: `rev-${Date.now()}`,
    author: resolvedAuthor,
    username: sessionUser ? sessionUser.username : '',
    role: sessionUser ? sessionUser.role : 'guest',
    rating: Math.max(1, Math.min(5, Number(rating || 5))),
    comment: cleanComment,
    date: new Date().toISOString().slice(0, 10)
  };
  all[slug].unshift(entry);
  writeJsonPretty(path.join(DATA_DIR, 'reviews.json'), all);
  res.json({ ok: true, entry, reviews: all[slug] });
});

app.get('/api/download/:slug/:platform', (req, res) => {
  // Check Anti-Abuse Download Shield Plugin
  const shield = readPlugins().find(p => p.id === 'download-shield' && p.enabled);
  if (shield) {
    const maxPerMin = Number(shield.config?.maxDownloadsPerMinute || 25);
    const ip = req.ip || 'local';
    const now = Date.now();
    const bucket = (downloadHits.get(ip) || []).filter(ts => now - ts < 60000);
    if (bucket.length >= maxPerMin) {
      return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED_BY_DOWNLOAD_SHIELD' });
    }
    bucket.push(now);
    downloadHits.set(ip, bucket);
  }

  const slug = sanitizeSlug(req.params.slug);
  const platform = String(req.params.platform || '').toLowerCase();
  const validPlatforms = ['windows', 'linux', 'macos', 'xbox', 'android', 'ios'];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({ error: 'INVALID_PLATFORM' });
  }

  const manifestPath = path.join(CATALOG_DIR, `${slug}.json`);
  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
  }

  const item = readJsonSafe(manifestPath, {});
  const platInfo = item?.platforms?.[platform];
  if (!platInfo || !platInfo.available) {
    return res.status(404).json({ error: 'BUILD_UNAVAILABLE_FOR_PLATFORM' });
  }

  const telemetry = readTelemetry();
  if (!telemetry[slug]) telemetry[slug] = { downloads: {} };
  if (!telemetry[slug].downloads) telemetry[slug].downloads = {};
  telemetry[slug].downloads[platform] = (telemetry[slug].downloads[platform] || 0) + 1;
  saveTelemetry(telemetry);

  if (platInfo.externalUrl && /^https?:\/\//i.test(platInfo.externalUrl)) {
    return res.redirect(302, platInfo.externalUrl);
  }

  const fileName = path.basename(platInfo.fileName || `${slug}-${platform}.pkg`);
  const fullPath = path.join(RELEASES_DIR, fileName);
  if (!fs.existsSync(fullPath)) {
    const stub = Buffer.from(
      `BYTETOPIA REPO — DEMO PACKAGE PLACEHOLDER\n` +
      `=======================================\n` +
      `PROJECT : ${item?.title?.en || slug}\n` +
      `PLATFORM: ${platform.toUpperCase()}\n` +
      `Upload your actual installer binary via CPanel!\n`
    );
    fs.writeFileSync(fullPath, stub);
  }

  if (platInfo.sha256) {
    res.setHeader('X-SHA256-Checksum', platInfo.sha256);
  }
  return res.download(fullPath, fileName);
});

// ================= FULL CPANEL & /admin API =================

app.get(['/cpanel', '/admin', '/wp-admin'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(EFFECTIVE_PUBLIC_DIR, 'cpanel.html'));
});

app.post('/api/admin/login', (req, res) => {
  const { username, password, desktopKey } = req.body || {};
  if (DESKTOP_AUTO_KEY && desktopKey === DESKTOP_AUTO_KEY) {
    const user = getRequestUser({ headers: { 'x-admin-token': DESKTOP_AUTO_KEY }, query: {} });
    return res.json({ ok: true, token: DESKTOP_AUTO_KEY, user: sanitizePublicUser(user), hasAdmin: hasAnyAdminUser() });
  }
  const cleanUser = normalizeUsername(username);
  const users = readUsers();
  if (users.length === 0) {
    return res.status(404).json({ error: 'NO_ACCOUNTS_YET' });
  }
  const found = users.find(u => String(u.username || '').toLowerCase() === cleanUser.toLowerCase());
  if (!found || !verifyUserPassword(String(password || ''), found)) {
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }
  if (found.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN_ADMIN_ONLY' });
  }
  const token = createSessionForUser(found.id);
  return res.json({ ok: true, token, user: sanitizePublicUser(found) });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { newPassword, targetUserId } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
  }
  const users = readUsers();
  const uid = targetUserId || req.adminUser.id;
  const idx = users.findIndex(u => u.id === uid);
  if (idx < 0) return res.status(404).json({ error: 'USER_NOT_FOUND' });

  const salt = crypto.randomBytes(16).toString('hex');
  users[idx].salt = salt;
  users[idx].passwordHash = hashUserPassword(String(newPassword), salt);
  saveUsers(users);
  res.json({ ok: true });
});

// Admin Users Management CRUD
app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  if (users[idx].isOwner && req.body?.role !== 'admin') {
    return res.status(400).json({ error: 'CANNOT_DEMOTE_PRIMARY_OWNER' });
  }
  users[idx].role = req.body?.role === 'admin' ? 'admin' : 'member';
  saveUsers(users);
  res.json({ ok: true, users: users.map(sanitizePublicUser) });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const users = readUsers();
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  if (target.isOwner) return res.status(400).json({ error: 'CANNOT_DELETE_PRIMARY_OWNER' });
  const nextUsers = users.filter(u => u.id !== req.params.id);
  saveUsers(nextUsers);
  res.json({ ok: true, users: nextUsers.map(sanitizePublicUser) });
});

// Full CPanel Dashboard State
app.get('/api/admin/cpanel-state', requireAdmin, (req, res) => {
  const siteConfig = readSiteConfig();
  const categories = readCategories();
  const plugins = readPlugins();
  const catalog = readCatalogAll(true);
  const posts = readPostsAll(true);
  const reviews = readReviews();
  const users = readUsers().map(sanitizePublicUser);
  const tor = getTorOnionStatus();
  const cloudflareUrl = getCloudflareUrl(siteConfig);

  // Compute storage usage
  let releasesBytes = 0;
  let releasesCount = 0;
  for (const f of fs.readdirSync(RELEASES_DIR)) {
    if (f === '.gitkeep') continue;
    const st = fs.statSync(path.join(RELEASES_DIR, f));
    if (st.isFile()) { releasesBytes += st.size; releasesCount++; }
  }

  res.json({
    currentAdmin: sanitizePublicUser(req.adminUser),
    siteConfig,
    categories,
    plugins,
    catalog,
    posts,
    reviews,
    users,
    ota: getLocalOtaStatus(),
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      nodeVersion: process.version,
      cpus: os.cpus().length,
      loadAvg: os.loadavg().map(n => n.toFixed(2)),
      memTotalMb: Math.round(os.totalmem() / (1024 * 1024)),
      memFreeMb: Math.round(os.freemem() / (1024 * 1024)),
      uptimeSeconds: Math.floor(process.uptime()),
      port: PORT,
      lanUrl: `http://${getLocalLanIp()}:${PORT}`,
      localUrl: `http://127.0.0.1:${PORT}`,
      torOnion: tor.onionHost,
      torLive: tor.liveFromContainer,
      torBootstrap: tor.bootstrap || 0,
      torRunning: Boolean(tor.running),
      cfRunning: Boolean(daemonState.cfRunning),
      daemonLogs: daemonState.logs.slice(-30),
      cloudflareUrl,
      releasesBytes,
      releasesFormatted: formatBytes(releasesBytes),
      releasesCount,
      dataDir: DATA_DIR,
      storageDir: STORAGE_DIR
    }
  });
});

// Live Tor (.onion) & Cloudflare Daemon Control Endpoints (for Portable Server & Docker/CasaOS)
app.post('/api/admin/daemons/restart-tor', requireAdmin, (req, res) => {
  const result = startManagedTor({ rotateKeys: false });
  res.json({ ok: true, ...result });
});

app.post('/api/admin/daemons/rotate-onion', requireAdmin, (req, res) => {
  const result = startManagedTor({ rotateKeys: true });
  res.json({ ok: true, ...result });
});

app.post('/api/admin/daemons/restart-cloudflare', requireAdmin, (req, res) => {
  const result = startManagedCloudflared();
  res.json({ ok: true, ...result });
});

// Update Runtime Tunnel Endpoints (accepts local Desktop Studio key or Admin session)
app.post('/api/admin/runtime-endpoints', (req, res) => {
  const tk = extractRequestToken(req);
  const isDesktopHost = Boolean(DESKTOP_AUTO_KEY && tk === DESKTOP_AUTO_KEY);
  const user = getRequestUser(req);
  if (!isDesktopHost && (!user || user.role !== 'admin')) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  const { torOnion, cloudflareUrl } = req.body || {};
  if (typeof torOnion === 'string' && torOnion.trim()) {
    fs.writeFileSync(path.join(DATA_DIR, 'runtime-tor-hostname'), torOnion.trim(), 'utf8');
  }
  if (typeof cloudflareUrl === 'string' && cloudflareUrl.trim()) {
    fs.writeFileSync(path.join(DATA_DIR, 'runtime-cf-url'), cloudflareUrl.trim(), 'utf8');
  }
  res.json({ ok: true });
});

app.put('/api/admin/site-config', requireAdmin, (req, res) => {
  const current = readSiteConfig();
  const body = { ...(req.body || {}) };
  // Sanitize brand/logo fields (responsive header: logoHeight 0 = auto, else 24-120px)
  if (body.logoHeight !== undefined) body.logoHeight = clampLogoHeight(body.logoHeight);
  if (body.logoUrl !== undefined) {
    body.logoUrl = String(body.logoUrl || '').trim().slice(0, 500);
    if (body.logoUrl && !/^(\/assets\/|\/uploads\/|https?:\/\/|data:image\/)/.test(body.logoUrl)) body.logoUrl = '';
  }
  if (body.brandCode !== undefined) body.brandCode = String(body.brandCode || 'BT').trim().toUpperCase().slice(0, 4) || 'BT';
  const updated = {
    ...current,
    ...body,
    network: { ...(current.network || {}), ...(body?.network || {}) }
  };
  writeJsonPretty(path.join(DATA_DIR, 'site-config.json'), updated);
  res.json({ ok: true, siteConfig: updated });
});

// Categories CRUD
app.put('/api/admin/categories', requireAdmin, (req, res) => {
  const list = Array.isArray(req.body?.categories) ? req.body.categories : [];
  writeJsonPretty(path.join(DATA_DIR, 'categories.json'), list);
  res.json({ ok: true, categories: list });
});

// Plugins CRUD & Custom Plugin Installer
app.put('/api/admin/plugins', requireAdmin, (req, res) => {
  const list = Array.isArray(req.body?.plugins) ? req.body.plugins : [];
  writeJsonPretty(path.join(DATA_DIR, 'plugins.json'), list);
  res.json({ ok: true, plugins: list });
});

app.post('/api/admin/plugins/install', requireAdmin, (req, res) => {
  const body = req.body || {};
  const id = sanitizeSlug(body.id || body.name?.en || `plugin-${Date.now()}`);
  const plugins = readPlugins();
  const existingIdx = plugins.findIndex(p => p.id === id);
  const pluginObj = {
    id,
    enabled: body.enabled !== false,
    builtin: false,
    name: body.name || { ar: id, en: id },
    description: body.description || { ar: 'إضافة مخصصة', en: 'Custom extension' },
    config: body.config || { customCss: '', customHtmlFooter: '', customJs: '' }
  };
  if (existingIdx >= 0) plugins[existingIdx] = pluginObj;
  else plugins.push(pluginObj);
  writeJsonPretty(path.join(DATA_DIR, 'plugins.json'), plugins);
  res.json({ ok: true, plugins });
});

app.delete('/api/admin/plugins/:id', requireAdmin, (req, res) => {
  const plugins = readPlugins().filter(p => p.builtin || p.id !== req.params.id);
  writeJsonPretty(path.join(DATA_DIR, 'plugins.json'), plugins);
  res.json({ ok: true, plugins });
});

// Apps & Games Catalog CRUD
app.post('/api/admin/catalog', requireAdmin, (req, res) => {
  const body = req.body || {};
  const slug = sanitizeSlug(body.slug || body?.title?.en || body?.title?.ar) || `app-${Date.now()}`;

  const existingPath = path.join(CATALOG_DIR, `${slug}.json`);
  const existing = readJsonSafe(existingPath, {});

  // Auto-fill English fallback from Arabic (or vice versa) so user only needs to write once!
  const titleAr = body?.title?.ar || body?.title?.en || existing?.title?.ar || slug;
  const titleEn = body?.title?.en || body?.title?.ar || existing?.title?.en || slug;
  const tagAr = body?.tagline?.ar ?? body?.tagline?.en ?? existing?.tagline?.ar ?? '';
  const tagEn = body?.tagline?.en || tagAr;
  const descAr = body?.description?.ar ?? body?.description?.en ?? existing?.description?.ar ?? '';
  const descEn = body?.description?.en || descAr;

  const defaultPlatforms = {};
  ['windows', 'linux', 'macos', 'xbox', 'android', 'ios'].forEach(p => {
    defaultPlatforms[p] = existing?.platforms?.[p] || {
      available: false,
      version: body.version || 'v1.0.0',
      size: '—',
      arch: p.toUpperCase(),
      format: p.toUpperCase(),
      fileName: '',
      externalUrl: '',
      url: `/api/download/${slug}/${p}`,
      sha256: '',
      notes: { ar: '', en: '' }
    };
  });

  const manifest = {
    ...existing,
    ...body,
    slug,
    title: { ar: titleAr, en: titleEn },
    tagline: { ar: tagAr, en: tagEn },
    description: { ar: descAr, en: descEn },
    status: body.status || existing.status || 'published',
    trailerUrl: body.trailerUrl !== undefined ? body.trailerUrl : (existing.trailerUrl || ''),
    screenshots: Array.isArray(body.screenshots) ? body.screenshots : (existing.screenshots || []),
    extraLinks: Array.isArray(body.extraLinks) ? body.extraLinks : (existing.extraLinks || []),
    optionalDemo: body.optionalDemo || existing.optionalDemo || { enabled: false, url: '' },
    platforms: body.platforms ? { ...defaultPlatforms, ...body.platforms } : defaultPlatforms
  };

  writeJsonPretty(existingPath, manifest);
  res.json({ ok: true, item: manifest, catalog: readCatalogAll(true) });
});

app.delete('/api/admin/catalog/:slug', requireAdmin, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const target = path.join(CATALOG_DIR, `${slug}.json`);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  res.json({ ok: true, catalog: readCatalogAll(true) });
});

// Topics / Articles / Devlogs CRUD
app.post('/api/admin/posts', requireAdmin, (req, res) => {
  const body = req.body || {};
  const slug = sanitizeSlug(body.slug || body?.title?.en || body?.title?.ar) || `post-${Date.now()}`;

  const existingPath = path.join(POSTS_DIR, `${slug}.json`);
  const existing = readJsonSafe(existingPath, {});
  const tAr = body?.title?.ar || body?.title?.en || existing?.title?.ar || slug;
  const tEn = body?.title?.en || tAr;
  const sAr = body?.summary?.ar ?? body?.summary?.en ?? existing?.summary?.ar ?? '';
  const sEn = body?.summary?.en || sAr;
  const cAr = body?.content?.ar ?? body?.content?.en ?? existing?.content?.ar ?? '';
  const cEn = body?.content?.en || cAr;
  const post = {
    ...existing,
    ...body,
    slug,
    title: { ar: tAr, en: tEn },
    summary: { ar: sAr, en: sEn },
    content: { ar: cAr, en: cEn },
    status: body.status || existing.status || 'published',
    date: body.date || existing.date || new Date().toISOString().slice(0, 10),
    views: existing.views || 0
  };
  writeJsonPretty(existingPath, post);
  res.json({ ok: true, post, posts: readPostsAll(true) });
});

app.delete('/api/admin/posts/:slug', requireAdmin, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const target = path.join(POSTS_DIR, `${slug}.json`);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  res.json({ ok: true, posts: readPostsAll(true) });
});

// Reviews Moderation
app.delete('/api/admin/reviews/:slug/:id', requireAdmin, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const all = readReviews();
  if (all[slug]) {
    all[slug] = all[slug].filter(r => r.id !== req.params.id);
    writeJsonPretty(path.join(DATA_DIR, 'reviews.json'), all);
  }
  res.json({ ok: true, reviews: all });
});

// File Manager Endpoints
app.get('/api/admin/files', requireAdmin, (req, res) => {
  const buckets = [
    { key: 'releases', label: 'storage/releases (Installers)', dir: RELEASES_DIR, urlPrefix: null },
    { key: 'media', label: 'assets/covers (Images & Screenshots)', dir: MEDIA_UPLOADS_DIR, urlPrefix: '/assets/covers/' },
    { key: 'catalog', label: 'data/catalog (App Manifests)', dir: CATALOG_DIR, urlPrefix: null },
    { key: 'posts', label: 'data/posts (Articles & Topics)', dir: POSTS_DIR, urlPrefix: null }
  ];
  const result = {};
  for (const b of buckets) {
    const items = [];
    if (fs.existsSync(b.dir)) {
      for (const name of fs.readdirSync(b.dir)) {
        if (name === '.gitkeep') continue;
        const fp = path.join(b.dir, name);
        const st = fs.statSync(fp);
        if (st.isFile()) {
          items.push({
            name,
            sizeBytes: st.size,
            sizeFormatted: formatBytes(st.size),
            modifiedAt: st.mtime.toISOString(),
            publicUrl: b.urlPrefix ? `${b.urlPrefix}${name}` : null
          });
        }
      }
    }
    result[b.key] = { label: b.label, files: items.sort((a, c) => c.modifiedAt.localeCompare(a.modifiedAt)) };
  }
  res.json({ buckets: result });
});

app.delete('/api/admin/files/:bucket/:name', requireAdmin, (req, res) => {
  const map = {
    releases: RELEASES_DIR,
    media: MEDIA_UPLOADS_DIR,
    catalog: CATALOG_DIR,
    posts: POSTS_DIR
  };
  const dir = map[req.params.bucket];
  const safeName = path.basename(req.params.name || '');
  if (!dir || !safeName || safeName === '.gitkeep') return res.status(400).json({ error: 'INVALID_TARGET' });
  const fp = path.join(dir, safeName);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

// Upload Media (Images & Video Trailers up to 4GB)
app.post('/api/admin/upload/media', requireAdmin, uploadTmp.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
  const ext = path.extname(req.file.originalname || '.jpg').toLowerCase();
  const imgExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif', '.bmp'];
  const vidExts = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.ogg', '.ogv', '.avi'];
  const allowed = [...imgExts, ...vidExts];
  if (!allowed.includes(ext)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'UNSUPPORTED_MEDIA_FORMAT' });
  }
  const slug = sanitizeSlug(req.body.slug || 'media') || 'media';
  const finalName = `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  const dest = path.join(MEDIA_UPLOADS_DIR, finalName);
  try {
    fs.renameSync(req.file.path, dest);
  } catch (_) {
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
  }
  const stat = fs.statSync(dest);
  res.json({
    ok: true,
    mediaUrl: `/assets/covers/${finalName}`,
    fileName: finalName,
    isVideo: vidExts.includes(ext),
    sizeFormatted: formatBytes(stat.size)
  });
});

// Upload Platform Binary & Compute Streaming SHA-256
app.post('/api/admin/upload/release/:slug/:platform', requireAdmin, uploadTmp.single('file'), async (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const platform = String(req.params.platform || '').toLowerCase();
  const validPlatforms = ['windows', 'linux', 'macos', 'xbox', 'android', 'ios'];
  if (!req.file || !validPlatforms.includes(platform)) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'INVALID_UPLOAD_REQUEST' });
  }

  const manifestPath = path.join(CATALOG_DIR, `${slug}.json`);
  if (!fs.existsSync(manifestPath)) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
  }

  try {
    const safeOrig = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]+/g, '_');
    const finalName = `${slug}-${platform}-${safeOrig}`;
    const destPath = path.join(RELEASES_DIR, finalName);
    fs.copyFileSync(req.file.path, destPath);
    fs.unlinkSync(req.file.path);

    const stat = fs.statSync(destPath);
    const sha256 = await computeFileSha256(destPath);

    const manifest = readJsonSafe(manifestPath, {});
    if (!manifest.platforms) manifest.platforms = {};
    manifest.platforms[platform] = {
      ...(manifest.platforms[platform] || {}),
      available: true,
      version: req.body.version || manifest.version || 'v1.0.0',
      size: formatBytes(stat.size),
      arch: req.body.arch || manifest.platforms?.[platform]?.arch || platform.toUpperCase(),
      format: path.extname(safeOrig).toUpperCase() || 'PACKAGE',
      fileName: finalName,
      externalUrl: '',
      url: `/api/download/${slug}/${platform}`,
      sha256
    };
    writeJsonPretty(manifestPath, manifest);
    res.json({ ok: true, platform: manifest.platforms[platform], item: manifest });
  } catch (err) {
    res.status(500).json({ error: err.message || 'UPLOAD_FAILED' });
  }
});

// Full Data Backup (.ZIP) & Restore (.ZIP)
app.get('/api/admin/storage-info', requireAdmin, (req, res) => {
  const os = require('os');
  let writable = false;
  try {
    const probe = path.join(DATA_DIR, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch (_) {}
  let size = 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'live-app' || e.name.startsWith('.ota-stage')) continue;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else { try { size += fs.statSync(fp).size; } catch (_) {} }
      }
    };
    walk(DATA_DIR);
  } catch (_) {}
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    writable,
    sizeBytes: size,
    sizeFormatted: formatBytes(size),
    platform: process.platform,
    bundlesRoot: BUNDLE_ROOT,
    overlayActive: fs.existsSync(path.join(LIVE_APP_DIR, 'server', 'index.js'))
  });
});

app.get('/api/admin/backup-zip', requireAdmin, (req, res) => {
  const zip = new AdmZip();
  zip.addLocalFolder(DATA_DIR, 'data');
  const buf = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="bytetopia-cpanel-backup-${Date.now()}.zip"`);
  res.send(buf);
});

app.post('/api/admin/restore-zip', requireAdmin, uploadTmp.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'NO_BACKUP_FILE' });
  try {
    const zip = new AdmZip(req.file.path);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const rel = entry.entryName.replace(/^data\//, '');
      const resolved = path.resolve(DATA_DIR, rel);
      if (!resolved.startsWith(DATA_DIR + path.sep)) throw new Error('ZIP_SLIP_BLOCKED');
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, entry.getData());
    }
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message || 'RESTORE_FAILED' });
  }
});

app.post('/api/admin/purge-catalog', requireAdmin, (req, res) => {
  for (const f of fs.readdirSync(CATALOG_DIR)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(CATALOG_DIR, f));
  }
  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(POSTS_DIR, f));
  }
  for (const f of fs.readdirSync(RELEASES_DIR)) {
    if (f !== '.gitkeep') fs.rmSync(path.join(RELEASES_DIR, f), { recursive: true, force: true });
  }
  saveTelemetry({});
  writeJsonPretty(path.join(DATA_DIR, 'reviews.json'), {});
  res.json({ ok: true });
});

// ================= CRYPTOGRAPHIC SHA-256 REPOSITORY OTA UPDATER =================

const DEFAULT_OTA_RAW_BASE = 'https://gitlab.com/itclubfayoum/bytetopia-repo/-/raw/main';
// Fallback raw bases (older installs may carry stale repo paths) — tried in order until one serves a valid manifest.
// Ordered by what actually answers. The old list pointed at two GitLab paths
// and one GitHub org that do not exist, so a rate-limited GitLab left the
// updater with nothing usable and the user saw a bare "update failed".
const OTA_RAW_BASE_FALLBACKS = [
  DEFAULT_OTA_RAW_BASE,
  'https://raw.githubusercontent.com/orlozuroffo-byte/bytetopia-ota/main',
  'https://gitlab.com/itclubfayoum/oddware-repo/-/raw/main',
  'https://gitlab.com/itclubfayoum/bytopia-repo/-/raw/main'
];
let httpServer = null;

function computeOtaBundleFingerprint(filesMap) {
  const sortedPaths = Object.keys(filesMap || {}).sort();
  const h = crypto.createHash('sha256');
  for (const rel of sortedPaths) {
    const info = filesMap[rel];
    if (!info || !info.sha256) return '';
    h.update(`${rel}:${info.sha256}:${info.size}\n`, 'utf8');
  }
  return h.digest('hex');
}

function sha256BufferHex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getOtaRawBaseUrl() {
  const cfg = readSiteConfig();
  const custom = String(cfg?.network?.otaRepoRawUrl || '').trim().replace(/\/+$/, '');
  return custom || DEFAULT_OTA_RAW_BASE;
}

function getLocalOtaStatus() {
  const activeManifest = readJsonSafe(path.join(ACTIVE_ROOT, 'ota-manifest.json'), null);
  const bundledManifest = readJsonSafe(path.join(BUNDLE_ROOT, 'ota-manifest.json'), null);
  const pkgJson = readJsonSafe(path.join(ACTIVE_ROOT, 'package.json'), { version: '3.4.0' });

  // Compute live fingerprint if manifest missing
  const m = activeManifest || bundledManifest || {};
  return {
    version: m.version || pkgJson.version || '3.4.0',
    buildSeq: m.buildSeq || 0,
    bundleSha256: m.bundleSha256 || '',
    updatedAt: m.updatedAt || '',
    notes: m.notes || { ar: '', en: '' },
    runningOverlay: process.env.BYTETOPIA_IS_OVERLAY === '1' || ACTIVE_ROOT === LIVE_APP_DIR,
    hasRollback: fs.existsSync(path.join(LIVE_APP_PREV_DIR, 'ota-manifest.json')) || fs.existsSync(path.join(LIVE_APP_DIR, 'ota-manifest.json')),
    supervised: process.env.BYTETOPIA_SUPERVISED === '1',
    repoRawBase: getOtaRawBaseUrl()
  };
}

async function fetchRemoteOtaManifest(overrideBase = '') {
  const cleanOverride = String(overrideBase || '').trim().replace(/\/+$/, '');
  const candidates = cleanOverride ? [cleanOverride] : [...new Set([getOtaRawBaseUrl(), ...OTA_RAW_BASE_FALLBACKS])];
  let lastErr = null;
  for (const baseUrl of candidates) {
    const url = `${baseUrl}/ota-manifest.json?t=${Date.now()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP_${res.status}_FETCHING_MANIFEST`);
        continue;
      }
      const remote = await res.json();
      if (!remote || typeof remote !== 'object' || !remote.files || !remote.bundleSha256) {
        lastErr = new Error('INVALID_REMOTE_MANIFEST_FORMAT');
        continue;
      }
      const recomputed = computeOtaBundleFingerprint(remote.files);
      if (recomputed !== remote.bundleSha256) {
        // Fingerprint mismatch on this mirror — do not trust it, try next candidate.
        lastErr = new Error('MANIFEST_FINGERPRINT_TAMPERED');
        continue;
      }
      return { baseUrl, remote };
    } catch (err) {
      if (err?.name === 'AbortError') {
        lastErr = otaError('OTA_ABORTED', baseUrl);
      } else if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(String(err?.message || ''))) {
        lastErr = otaError('OTA_NO_WORKING_REPOSITORY', `${baseUrl} — ${err?.cause?.code || 'network'}`);
      } else {
        lastErr = err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || otaError('OTA_NO_WORKING_REPOSITORY');
}

function diffAgainstActiveDisk(remoteFiles) {
  const changed = [];
  for (const [relPath, expected] of Object.entries(remoteFiles)) {
    // Prevent path traversal
    const safeRel = path.posix.normalize(relPath);
    if (safeRel.startsWith('..') || path.isAbsolute(safeRel)) {
      throw new Error(`UNSAFE_MANIFEST_PATH:${relPath}`);
    }
    const localAbs = path.join(ACTIVE_ROOT, safeRel);
    if (!fs.existsSync(localAbs)) {
      changed.push({ path: safeRel, status: 'added', sha256: expected.sha256, size: expected.size });
      continue;
    }
    try {
      const localBuf = fs.readFileSync(localAbs);
      const localHash = sha256BufferHex(localBuf);
      if (localHash !== expected.sha256) {
        changed.push({ path: safeRel, status: 'modified', sha256: expected.sha256, size: expected.size });
      }
    } catch (_) {
      changed.push({ path: safeRel, status: 'modified', sha256: expected.sha256, size: expected.size });
    }
  }
  return changed;
}

function scheduleOtaHotRestart() {
  setTimeout(() => {
    try { stopManagedTor(); } catch (_) {}
    try { stopManagedCloudflared(); } catch (_) {}
    if (process.env.BYTETOPIA_SUPERVISED === '1') {
      if (httpServer) {
        httpServer.close(() => process.exit(75));
        setTimeout(() => process.exit(75), 800).unref();
      } else {
        process.exit(75);
      }
    }
  }, 350);
}

app.get('/api/admin/ota/status', requireAdmin, (req, res) => {
  res.json({ ok: true, local: getLocalOtaStatus() });
});

// ==================== BULLETPROOF OTA (v2) ====================
// Rules that make updates dependable:
//  1. The staged manifest lists EXACTLY what was staged. (Listing extra files made
//     boot.js reject the overlay forever -> updates silently never activated.)
//  2. Every failure returns {ok:false, code, message(ar), detail} — never a bare 500.
//  3. Identical local files are reused instead of re-downloaded.
//  4. User state never travels over the air.
//  5. The dev git worktree is never overwritten by an update.

const OTA_PROTECTED_PREFIXES = [
  'data/users.json', 'data/sessions.json', 'data/site-config.json',
  'data/telemetry.json', 'data/reviews.json', 'data/posts/',
  'data/tor-keys/', 'uploads/'
];

function isProtectedFromOta(relPath) {
  const rel = path.posix.normalize(relPath);
  return OTA_PROTECTED_PREFIXES.some((p) => rel === p || rel.startsWith(p));
}

function otaError(code, detail) {
  const e = new Error(code);
  e.otaCode = code;
  e.detail = detail || '';
  return e;
}

function describeOtaError(err) {
  const code = err?.otaCode || err?.message || 'OTA_UNKNOWN_ERROR';
  const map = [
    ['HTTP_401_FETCHING_MANIFEST', 'المستودع رفض الطلب (401) — تأكد أن المشروع عام (Public).'],
    ['HTTP_403_FETCHING_MANIFEST', 'المستودع رفض الوصول (403) — رابط المستودع غير صحيح.'],
    ['HTTP_404_FETCHING_MANIFEST', 'ملف التحديث غير موجود (404) — مسار المستودع خاطئ.'],
    ['HTTP_429', 'المستودع يحدّ من الطلبات مؤقتًا (429) — انتظر دقيقة وأعد المحاولة.'],
    ['INVALID_REMOTE_MANIFEST_FORMAT', 'ملف التحديث تالف أو بصيغة غير مفهومة.'],
    ['MANIFEST_FINGERPRINT_TAMPERED', 'بصمة ملف التحديث غير مطابقة — رُفض التحديث لحمايتك.'],
    ['OTA_NO_WORKING_REPOSITORY', 'تعذّر الوصول لمستودع التحديث — تحقق من الإنترنت.'],
    ['OTA_ABORTED', 'انتهت مهلة الاتصال بالمستودع — أعد المحاولة.'],
    ['NO_FILES_TO_UPDATE', 'لا توجد ملفات جديدة — نسختك محدّثة بالفعل.'],
    ['INCOMPLETE_PAYLOAD', 'الحزمة ناقصة (server/index.js مفقود) — أُلغيت العملية.'],
    ['SHA256_MISMATCH', 'ملف نزل تالف (بصمة غير متطابقة) — أُلغي التحديث بأمان.'],
    ['DOWNLOAD_FAILED', 'فشل تنزيل أحد ملفات التحديث — أعد المحاولة.'],
    ['UNSAFE_MANIFEST_PATH', 'مسار غير آمن داخل ملف التحديث — رُفض.'],
    ['PATH_ESCAPE', 'محاولة كتابة خارج مجلد التحديث — رُفضت.']
  ];
  for (const [k, msg] of map) {
    if (String(code).includes(k)) return { code, message: msg, detail: String(err?.detail || '').slice(0, 300) };
  }
  return { code, message: String(err?.detail || err?.message || code).slice(0, 300), detail: '' };
}

async function downloadOtaFile(baseUrl, relPath, expected, destAbs, attempt = 1) {
  const url = `${baseUrl}/${relPath}?t=${Date.now()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    if (!res.ok) {
      if (res.status >= 500 && attempt < 3) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 400 * attempt));
        return downloadOtaFile(baseUrl, relPath, expected, destAbs, attempt + 1);
      }
      throw otaError(`DOWNLOAD_FAILED_HTTP_${res.status}`, relPath);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = sha256BufferHex(buf);
    if (actual !== expected.sha256) {
      if (attempt < 3) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 400 * attempt));
        return downloadOtaFile(baseUrl, relPath, expected, destAbs, attempt + 1);
      }
      throw otaError('SHA256_MISMATCH',
        `${relPath} (متوقع ${String(expected.sha256).slice(0, 12)}, وصل ${actual.slice(0, 12)})`);
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.writeFileSync(destAbs, buf);
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') throw otaError('OTA_ABORTED', relPath);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.all('/api/admin/ota/check', requireAdmin, async (req, res) => {
  try {
    const local = getLocalOtaStatus();
    const overrideBase = req.body?.repoRawBase || req.query?.repoRawBase || '';
    const { baseUrl, remote } = await fetchRemoteOtaManifest(overrideBase);

    const shippableMap = Object.fromEntries(
      Object.entries(remote.files).filter(([rel]) => !isProtectedFromOta(rel))
    );
    const changedFiles = diffAgainstActiveDisk(shippableMap);
    const totalBytes = changedFiles.reduce((acc, f) => acc + (f.size || 0), 0);

    res.json({
      ok: true,
      updateAvailable: changedFiles.length > 0,
      changedFilesCount: changedFiles.length,
      changedFiles: changedFiles.slice(0, 80),
      totalDownloadFormatted: formatBytes(totalBytes),
      totalDownloadBytes: totalBytes,
      local,
      remote: {
        version: remote.version,
        buildSeq: remote.buildSeq,
        bundleSha256: remote.bundleSha256,
        updatedAt: remote.updatedAt,
        notes: remote.notes || { ar: '', en: '' },
        repoRawBase: baseUrl
      }
    });
  } catch (err) {
    const info = describeOtaError(err);
    console.error('[OTA CHECK ERROR]', info.code, info.detail);
    res.status(200).json({ ok: false, ...info });
  }
});

// ================= OTA v3 — resilient updater (see server/ota-engine.js) =================
// The old routes stay for compatibility; the UI now uses these because they
// report the exact failure reason and every repository URL that was tried.

function otaSourcesFor(req) {
  const cfg = readSiteConfig();
  const custom = String(
    (req && req.body && req.body.repoRawBase) ||
    (req && req.query && req.query.repoRawBase) ||
    (cfg && cfg.network && cfg.network.otaRepoRawUrl) ||
    ''
  ).trim().replace(/\/+$/, '');
  const list = [];
  if (custom) list.push(custom);
  for (const s of otaEngine.DEFAULT_SOURCES) {
    if (list.indexOf(s) === -1) list.push(s);
  }
  return list;
}

function otaTokenFor() {
  const cfg = readSiteConfig();
  return String((cfg && cfg.network && cfg.network.otaRepoToken) || '').trim();
}

/** Swap a verified staging folder into data/live-app, keeping one backup. */
function promoteStagedOverlay(stageDir) {
  const prevDir = path.join(DATA_DIR, 'live-app-prev');
  const liveDir = path.join(DATA_DIR, 'live-app');
  try {
    fs.rmSync(prevDir, { recursive: true, force: true });

    if (fs.existsSync(liveDir)) {
      fs.renameSync(liveDir, prevDir);
    } else {
      // First over-the-air update on an install that has never had an overlay:
      // there is no live-app to rotate, so the manifest that was in force until
      // now is the one sitting in the bundle root (or the active root when the
      // app is already running from somewhere else). Preserve just that manifest
      // as live-app-prev, otherwise the next update has nothing to compare
      // against and cannot tell which catalog entries this update retired.
      const inForceManifest = path.join(ACTIVE_ROOT, 'ota-manifest.json');
      const bundledManifest = path.join(BUNDLE_ROOT, 'ota-manifest.json');
      const source = fs.existsSync(inForceManifest)
        ? inForceManifest
        : (fs.existsSync(bundledManifest) ? bundledManifest : null);
      if (source) {
        fs.mkdirSync(prevDir, { recursive: true });
        fs.copyFileSync(source, path.join(prevDir, 'ota-manifest.json'));
      }
    }

    fs.mkdirSync(path.dirname(liveDir), { recursive: true });
    fs.renameSync(stageDir, liveDir);
    return true;
  } catch (err) {
    try {
      if (!fs.existsSync(liveDir) && fs.existsSync(prevDir)) fs.renameSync(prevDir, liveDir);
    } catch (_) {}
    return false;
  }
}

app.get('/api/admin/ota/v3/check', requireAdmin, async function (req, res) {
  try {
    const sources = otaSourcesFor(req);
    const got = await otaEngine.fetchManifest(sources, { token: otaTokenFor() });
    const local = getLocalOtaStatus();
    const remoteSeq = Number(got.manifest.buildSeq || 0);
    const localSeq = Number(local.buildSeq || 0);
    const sameBundle = got.manifest.bundleSha256 === local.bundleSha256;
    res.json({
      ok: true,
      updateAvailable: !sameBundle && (remoteSeq > localSeq || got.manifest.version !== local.version),
      currentVersion: local.version,
      currentSeq: localSeq,
      remoteVersion: got.manifest.version,
      remoteSeq: remoteSeq,
      notes: got.manifest.notes || { ar: '', en: '' },
      fileCount: Object.keys(got.manifest.files || {}).length,
      repoRawBase: got.baseUrl,
      tried: got.tried
    });
  } catch (err) {
    res.json({
      ok: false,
      code: err.otaCode || 'OTA_UNKNOWN',
      message: err.otaMessageAr || err.message,
      messageEn: (err.otaCode && otaEngine.REASONS[err.otaCode]) || err.message,
      detail: err.otaDetail,
      tried: Array.isArray(err.otaDetail) ? err.otaDetail : []
    });
  }
});

app.post('/api/admin/ota/v3/apply', requireAdmin, async function (req, res) {
  const stageDir = path.join(DATA_DIR, '.ota-v3-' + Date.now());
  try {
    const sources = otaSourcesFor(req);
    const got = await otaEngine.fetchManifest(sources, { token: otaTokenFor() });

    const wanted = {};
    Object.keys(got.manifest.files).forEach(function (rel) {
      if (!isProtectedFromOta(rel)) wanted[rel] = got.manifest.files[rel];
    });
    if (!wanted['server/index.js']) {
      return res.json({ ok: false, code: 'INCOMPLETE_PAYLOAD', message: 'ملف التحديث لا يحتوي على server/index.js', detail: '' });
    }

    const scoped = Object.assign({}, got.manifest, { files: wanted });
    // Try the single-archive payload first. It is one request instead of one
    // per file, which is the difference between finishing an update and being
    // cut off by GitLab's per-user rate limit halfway through. Returns null when
    // the repository has no payload yet, in which case the per-file path below
    // still works exactly as before.
    let staged = null;
    try {
      staged = await otaEngine.stageFromPayload(scoped, got.baseUrl, stageDir, {
        token: otaTokenFor(),
        currentRoot: ACTIVE_ROOT
      });
    } catch (err) {
      // A 429 here is worth surfacing instead of silently falling back; any
      // other payload problem falls through to the per-file path.
      if (err && err.otaCode === 'OTA_RATE_LIMITED') throw err;
      staged = null;
    }
    if (!staged) {
      staged = await otaEngine.stageFiles(scoped, got.baseUrl, stageDir, {
        token: otaTokenFor(),
        currentRoot: ACTIVE_ROOT
      });
    }

    const check = otaEngine.verifyStaged(stageDir);
    if (!check.ok) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      return res.json({ ok: false, code: 'STAGED_VERIFY_FAILED', message: 'الملفات المنزّلة لا تطابق بصماتها', detail: check.reason });
    }

    const swapped = promoteStagedOverlay(stageDir);
    const supervised = process.env.BYTETOPIA_SUPERVISED === '1';
    res.json({
      ok: true,
      updated: true,
      version: check.manifest.version,
      buildSeq: check.manifest.buildSeq,
      bundleSha256: check.manifest.bundleSha256,
      downloadedCount: staged.downloaded,
      viaPayload: !!staged.viaPayload,
      reusedCount: staged.reused,
      stagedFilesCount: check.fileCount,
      notes: check.manifest.notes || { ar: '', en: '' },
      repoRawBase: got.baseUrl,
      swapped: swapped,
      // Under boot.js the process restarts itself a moment after this response,
      // so the new overlay goes live without the user closing the app. Without
      // a supervisor the caller still has to restart, and the panel says so.
      restarting: supervised,
      restartRequired: !supervised
    });

    // Without this the apply reported success and the server kept running the
    // old code in memory: the files on disk were new, the app was not.
    if (supervised) scheduleOtaHotRestart();
  } catch (err) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    res.json({
      ok: false,
      code: err.otaCode || 'OTA_UNKNOWN',
      message: err.otaMessageAr || err.message,
      messageEn: (err.otaCode && otaEngine.REASONS[err.otaCode]) || err.message,
      detail: (err.otaDetail && typeof err.otaDetail === 'object') ? err.otaDetail : String(err.otaDetail || '')
    });
  }
});

app.get('/api/admin/ota/v3/history', requireAdmin, function (req, res) {
  res.json({ ok: true, active: getLocalOtaStatus(), sources: otaSourcesFor({ body: {}, query: {} }) });
});


app.post('/api/admin/ota/apply', requireAdmin, async (req, res) => {
  const stageDir = path.join(DATA_DIR, `.ota-stage-${Date.now()}`);
  let swapped = false;
  try {
    const overrideBase = req.body?.repoRawBase || req.query?.repoRawBase || '';
    const { baseUrl, remote } = await fetchRemoteOtaManifest(overrideBase);

    const entries = Object.entries(remote.files).filter(([rel]) => !isProtectedFromOta(rel));
    if (!entries.length) return res.json({ ok: false, ...describeOtaError(otaError('NO_FILES_TO_UPDATE')) });

    fs.mkdirSync(stageDir, { recursive: true });
    let downloadedCount = 0;
    let reusedCount = 0;
    const stagedFiles = {};

    for (let i = 0; i < entries.length; i += 6) {
      await Promise.all(entries.slice(i, i + 6).map(async ([relPath, expected]) => {
        const safeRel = path.posix.normalize(relPath);
        if (safeRel.startsWith('..') || path.isAbsolute(safeRel)) {
          throw otaError('UNSAFE_MANIFEST_PATH', relPath);
        }
        const destAbs = path.join(stageDir, safeRel);
        if (!path.resolve(destAbs).startsWith(path.resolve(stageDir) + path.sep)) {
          throw otaError('PATH_ESCAPE', relPath);
        }
        const localAbs = path.join(ACTIVE_ROOT, safeRel);
        if (fs.existsSync(localAbs)) {
          try {
            const localBuf = fs.readFileSync(localAbs);
            if (sha256BufferHex(localBuf) === expected.sha256) {
              fs.mkdirSync(path.dirname(destAbs), { recursive: true });
              fs.writeFileSync(destAbs, localBuf);
              stagedFiles[safeRel] = { sha256: expected.sha256, size: localBuf.length };
              reusedCount++;
              return;
            }
          } catch (_) {}
        }
        await downloadOtaFile(baseUrl, safeRel, expected, destAbs);
        stagedFiles[safeRel] = { sha256: expected.sha256, size: expected.size };
        downloadedCount++;
      }));
    }

    if (!stagedFiles['server/index.js']) throw otaError('INCOMPLETE_PAYLOAD', 'server/index.js');

    // Manifest describes ONLY what is really on disk -> boot.js can verify it.
    const overlayManifest = {
      ...remote,
      files: stagedFiles,
      bundleSha256: computeOtaBundleFingerprint(stagedFiles)
    };
    writeJsonPretty(path.join(stageDir, 'ota-manifest.json'), overlayManifest);

    fs.rmSync(LIVE_APP_PREV_DIR, { recursive: true, force: true });
    if (fs.existsSync(LIVE_APP_DIR)) fs.renameSync(LIVE_APP_DIR, LIVE_APP_PREV_DIR);
    fs.renameSync(stageDir, LIVE_APP_DIR);
    swapped = true;

    const isDevWorktree = fs.existsSync(path.join(BUNDLE_ROOT, '.git'));
    if (process.env.BYTETOPIA_SUPERVISED !== '1' && !isDevWorktree) {
      try {
        for (const relPath of Object.keys(stagedFiles)) {
          if (relPath === 'data' || relPath.startsWith('data/')) continue;
          const dstAbs = path.join(BUNDLE_ROOT, relPath);
          fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
          fs.copyFileSync(path.join(LIVE_APP_DIR, relPath), dstAbs);
        }
        fs.copyFileSync(path.join(LIVE_APP_DIR, 'ota-manifest.json'),
                        path.join(BUNDLE_ROOT, 'ota-manifest.json'));
      } catch (_) {}
    }

    res.json({
      ok: true, updated: true,
      version: overlayManifest.version,
      buildSeq: overlayManifest.buildSeq,
      bundleSha256: overlayManifest.bundleSha256,
      downloadedCount, reusedCount,
      stagedFilesCount: Object.keys(stagedFiles).length,
      notes: overlayManifest.notes || { ar: '', en: '' },
      restarting: process.env.BYTETOPIA_SUPERVISED === '1'
    });

    scheduleOtaHotRestart();
  } catch (err) {
    try { if (!swapped) fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    const info = describeOtaError(err);
    console.error('[OTA APPLY ERROR]', info.code, info.detail);
    const fatal = /SHA256_MISMATCH|TAMPERED|UNSAFE|ESCAPE/.test(info.code);
    res.status(fatal ? 400 : 200).json({ ok: false, ...info });
  }
});

app.post('/api/admin/ota/rollback', requireAdmin, (req, res) => {
  try {
    if (fs.existsSync(path.join(LIVE_APP_PREV_DIR, 'ota-manifest.json'))) {
      fs.rmSync(LIVE_APP_DIR, { recursive: true, force: true });
      fs.renameSync(LIVE_APP_PREV_DIR, LIVE_APP_DIR);
    } else {
      fs.rmSync(LIVE_APP_DIR, { recursive: true, force: true });
    }
    res.json({ ok: true, restarting: process.env.BYTETOPIA_SUPERVISED === '1' });
    scheduleOtaHotRestart();
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'ROLLBACK_FAILED' });
  }
});

// Static mounts (serve uploaded covers from persistent MEDIA_UPLOADS_DIR first, then active/bundled assets)
app.use('/assets/covers', express.static(MEDIA_UPLOADS_DIR));
app.use('/assets/covers', express.static(path.join(EFFECTIVE_PUBLIC_DIR, 'assets', 'covers')));
app.use('/assets/covers', express.static(path.join(BUNDLE_ROOT, 'public', 'assets', 'covers')));
app.use('/hosted-demos', express.static(WEB_BUILDS_DIR));
app.use(express.static(EFFECTIVE_PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

app.use((req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.sendFile(path.join(EFFECTIVE_PUBLIC_DIR, 'index.html'));
  }
  res.status(404).json({ error: 'NOT_FOUND' });
});

httpServer = app.listen(PORT, HOST, () => {
  console.log(`[BYTETOPIA SERVER v3.4.0] Listening on http://${HOST}:${PORT} (root=${ACTIVE_ROOT})`);
  console.log(`[BYTETOPIA LAN] Local/LAN URL: http://${getLocalLanIp()}:${PORT}`);
  startManagedTor({ rotateKeys: false });
  startManagedCloudflared();
});
