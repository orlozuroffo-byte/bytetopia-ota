#!/usr/bin/env node
/**
 * BYTETOPIA Cryptographic OTA Supervisor & Overlay Bootloader (server/boot.js)
 * - Verifies SHA-256 manifest integrity before booting any live OTA overlay.
 * - Keeps parent PID alive across Docker, Portable Server, and PySide6 AppImage/.deb
 *   while seamlessly hot-restarting server/index.js on exit code 75 after OTA updates!
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const OTA_RESTART_EXIT_CODE = 75;
const BUNDLE_ROOT = process.env.BYTETOPIA_BUNDLE_ROOT || process.env.ODDWARE_BUNDLE_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.BYTETOPIA_DATA_DIR || process.env.ODDWARE_DATA_DIR || path.join(BUNDLE_ROOT, 'data');
const LIVE_APP_DIR = path.join(DATA_DIR, 'live-app');

function computeBundleFingerprint(filesMap) {
  const sortedPaths = Object.keys(filesMap || {}).sort();
  const h = crypto.createHash('sha256');
  for (const rel of sortedPaths) {
    const info = filesMap[rel];
    if (!info || !info.sha256) return '';
    h.update(`${rel}:${info.sha256}:${info.size}\n`, 'utf8');
  }
  return h.digest('hex');
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readVerifiedManifest(rootDir) {
  try {
    const mPath = path.join(rootDir, 'ota-manifest.json');
    if (!fs.existsSync(mPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    if (!manifest || !manifest.files || !manifest.bundleSha256) return null;

    const computed = computeBundleFingerprint(manifest.files);
    if (computed !== manifest.bundleSha256) {
      console.error(`[OTA BOOT] Fingerprint mismatch in ${mPath}! Expected ${manifest.bundleSha256}, got ${computed}`);
      return null;
    }

    const serverEntry = manifest.files['server/index.js'];
    const serverPath = path.join(rootDir, 'server', 'index.js');
    if (!serverEntry || !fs.existsSync(serverPath)) return null;
    if (sha256File(serverPath) !== serverEntry.sha256) {
      console.error(`[OTA BOOT] server/index.js SHA-256 mismatch in ${rootDir}!`);
      return null;
    }
    return manifest;
  } catch (err) {
    console.error(`[OTA BOOT] Failed reading manifest in ${rootDir}:`, err.message);
    return null;
  }
}

function resolveActiveRoot() {
  const bundled = readVerifiedManifest(BUNDLE_ROOT);
  const live = readVerifiedManifest(LIVE_APP_DIR);

  if (live) {
    const bSeq = bundled?.buildSeq || 0;
    const lSeq = live?.buildSeq || 0;
    if (lSeq >= bSeq) {
      console.log(`[OTA BOOT] Booting verified OTA live overlay v${live.version} (seq=${lSeq}, sha256=${live.bundleSha256.slice(0, 16)}...)`);
      return { root: LIVE_APP_DIR, isOverlay: true, manifest: live };
    }
  }
  return { root: BUNDLE_ROOT, isOverlay: false, manifest: bundled };
}

let activeChild = null;
let shuttingDown = false;

function launchServer() {
  const chosen = resolveActiveRoot();
  const entryScript = path.join(chosen.root, 'server', 'index.js');
  const nodeModulesPath = path.join(BUNDLE_ROOT, 'node_modules');

  const env = {
    ...process.env,
    NODE_PATH: process.env.NODE_PATH
      ? `${nodeModulesPath}${path.delimiter}${process.env.NODE_PATH}`
      : nodeModulesPath,
    BYTETOPIA_BUNDLE_ROOT: BUNDLE_ROOT,
    BYTETOPIA_ACTIVE_ROOT: chosen.root,
    BYTETOPIA_LIVE_PUBLIC_DIR: path.join(chosen.root, 'public'),
    BYTETOPIA_IS_OVERLAY: chosen.isOverlay ? '1' : '0',
    BYTETOPIA_SUPERVISED: '1',
    // Legacy mirrors so pre-rebrand OTA overlays still boot
    ODDWARE_BUNDLE_ROOT: BUNDLE_ROOT,
    ODDWARE_ACTIVE_ROOT: chosen.root,
    ODDWARE_LIVE_PUBLIC_DIR: path.join(chosen.root, 'public'),
    ODDWARE_IS_OVERLAY: chosen.isOverlay ? '1' : '0',
    ODDWARE_SUPERVISED: '1'
  };

  activeChild = spawn(process.execPath, [entryScript], {
    cwd: BUNDLE_ROOT,
    env,
    stdio: 'inherit'
  });

  activeChild.on('exit', (code, signal) => {
    activeChild = null;
    if (shuttingDown) {
      process.exit(0);
    }
    if (code === OTA_RESTART_EXIT_CODE) {
      console.log('[OTA BOOT] Hot-restarting server with newly verified repository update...');
      setTimeout(launchServer, 150);
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function forwardShutdown(sig) {
  shuttingDown = true;
  if (activeChild) {
    try { activeChild.kill(sig); } catch (_) {}
    setTimeout(() => process.exit(0), 1500).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => forwardShutdown('SIGTERM'));
process.on('SIGINT', () => forwardShutdown('SIGINT'));

launchServer();
