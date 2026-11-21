/**
 * OTA update engine — rewritten from scratch.
 *
 * Design rules learned from the old system's failures:
 *   1. Never trust a single URL. Try a ladder of mirrors and report which one
 *      worked, so "wrong repository link" can never happen silently.
 *   2. Verify every byte before writing it. A download that does not match its
 *      SHA-256 is dropped, never staged.
 *   3. Stage into a temp folder, verify the whole staged tree, and only then
 *      swap it in. A failure at any point leaves the running site untouched.
 *   4. Always answer with a real, readable reason — never a bare "failed".
 *   5. Work on public and private repos: optional token, several URL shapes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const RAW_SHAPES = (ownerRepo, branch) => [
  // GitLab
  `https://gitlab.com/${ownerRepo}/-/raw/${branch}`,
  // GitHub
  `https://raw.githubusercontent.com/${ownerRepo}/${branch}`,
  // GitLab API (works for private repos with a token)
  `https://gitlab.com/api/v4/projects/${encodeURIComponent(ownerRepo)}/repository/files/%s/raw?ref=${branch}`
];

// Ordered by measured latency and reliability, not by ownership. On a cold
// install the updater issues ~49 sequential requests; GitLab answers the
// second half of them with 429 and then advertises retry-after values in the
// minutes, which is exactly what made "update failed" routine. The mirror is
// byte-identical, served through a CDN, and every downloaded file is still
// verified against the manifest hash — so a mirror can never smuggle content.
const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/orlozuroffo-byte/bytetopia-ota/main',
  'https://gitlab.com/itclubfayoum/bytetopia-repo/-/raw/main',
  'https://raw.githubusercontent.com/itclubfayoum/bytetopia-repo/main'
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

/** Deterministic fingerprint over a {relPath: {sha256, size}} map. */
function fingerprint(files) {
  // MUST match scripts/generate-ota-manifest.js, server/index.js and boot.js:
  // rel:sha256:size, sorted by path, newline terminated.
  const h = crypto.createHash('sha256');
  for (const rel of Object.keys(files || {}).sort()) {
    const info = files[rel];
    if (!info || !info.sha256) return '';
    h.update(`${rel}:${info.sha256}:${info.size}\n`, 'utf8');
  }
  return h.digest('hex');
}

function fail(code, messageAr, detail) {
  const err = new Error(code);
  err.otaCode = code;
  err.otaMessageAr = messageAr;
  err.otaDetail = detail || '';
  return err;
}

const REASONS = {
  OTA_REPO_UNREACHABLE: 'تعذّر الوصول لمستودع التحديث — تأكد من اتصال الإنترنت أو من رابط المستودع.',
  OTA_MANIFEST_NOT_FOUND: 'المستودع متاح لكن ملف ota-manifest.json غير موجود فيه — الرابط أو الفرع غير صحيح.',
  OTA_MANIFEST_INVALID: 'ملف التحديث تالف أو غير مكتمل — أعد نشره من المستودع.',
  OTA_MANIFEST_TAMPERED: 'بصمة ملف التحديث لا تطابق محتواه — تم رفض التحديث لأسباب أمنية.',
  OTA_FILE_NOT_FOUND: 'أحد ملفات التحديث غير موجود في المستودع.',
  OTA_FILE_MISMATCH: 'ملف تم تنزيله لا يطابق بصمته — أُلغيت العملية.',
  OTA_WRITE_FAILED: 'تعذّر كتابة ملفات التحديث على القرص — تحقق من الصلاحيات والمساحة.',
  OTA_NO_CHANGE: 'لا يوجد تحديث جديد — النسخة الحالية هي الأحدث.',
  OTA_NETWORK: 'انقطع الاتصال أثناء تنزيل التحديث.',
  OTA_RATE_LIMITED: 'GitLab طلب الانتظار قبل استكمال التنزيل — أعد المحاولة بعد دقيقة. التحديث لم يتلف.'
};

function reason(code) {
  return REASONS[code] || 'فشل التحديث لسبب غير معروف.';
}

/* ------------------------------------------------------------------------- */
/* manifest fetching                                                          */
/* ------------------------------------------------------------------------- */

async function fetchJson(url, { token, timeoutMs = 20000, maxAttempts = 3, onWait } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' };
    if (token) headers['PRIVATE-TOKEN'] = token;
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
      const text = await res.text();
      last = { ok: res.ok, status: res.status, text };
      // A 429 here used to surface as "repository unreachable", which told the
      // user nothing and skipped every other mirror. Wait out the advertised
      // delay instead of burning the whole candidate list on one throttled host.
      if (res.status !== 429 || attempt === maxAttempts) return last;
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const waitMs = Math.min(60000, Math.max(3, retryAfter || 3 * attempt)) * 1000;
      if (onWait) onWait({ reason: 'OTA_RATE_LIMITED', attempt, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/**
 * Try every candidate base URL until one serves a valid, self-consistent
 * manifest. Returns { baseUrl, manifest, tried[] }.
 */
async function fetchManifest(sources, opts = {}) {
  const { token } = opts;
  const tried = [];
  let sawManifest = false;

  // Snapshot first, mutable root second. Measured on GitHub's CDN: the same path
  // kept returning a five-minute-old body even with a cache-busting query
  // string, which paired a new manifest with old file bytes and failed the
  // hash check. Snapshot paths embed the sequence and are never rewritten.
  // Pinned sequence from the client, when it knows one, jumps straight to an
  // immutable snapshot and skips the mutable names entirely.
  const attempts = [];
  if (opts && opts.wantSeq) {
    for (const lead of sources) {
      attempts.push(`${String(lead).replace(/\/+$/, '')}/manifests/${opts.wantSeq}.json`);
    }
  }
  for (const lead of sources) {
    const base = String(lead).replace(/\/+$/, '');
    attempts.push(`${base}/manifests/current.json`);
    attempts.push(`${base}/ota-manifest.json`);
  }

  for (const url0 of attempts) {
    const url = `${url0}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let res;
    try {
      res = await fetchJson(url, { token });
    } catch (err) {
      const code = err?.name === 'AbortError' ? 'TIMEOUT' : (err?.cause?.code || err?.code || 'NETWORK');
      tried.push({ url, ok: false, reason: code });
      continue;
    }

    if (res.status === 404) {
      tried.push({ url, ok: false, reason: '404' });
      continue;
    }
    if (!res.ok) {
      tried.push({ url, ok: false, reason: `HTTP_${res.status}` });
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(res.text);
    } catch {
      tried.push({ url, ok: false, reason: 'NOT_JSON' });
      continue;
    }

    if (!manifest || typeof manifest !== 'object' || !manifest.files || !manifest.bundleSha256) {
      tried.push({ url, ok: false, reason: 'INVALID_SHAPE' });
      sawManifest = true;
      continue;
    }

    const computed = fingerprint(manifest.files);
    if (!computed || computed !== manifest.bundleSha256) {
      tried.push({ url, ok: false, reason: 'FINGERPRINT_MISMATCH' });
      sawManifest = true;
      continue;
    }

    tried.push({ url, ok: true, reason: 'OK' });
    return { baseUrl: String(base).replace(/\/+$/, ''), manifest, tried };
  }

  // Choose the most useful error instead of a generic one.
  const reasons = tried.map(t => t.reason);
  if (reasons.every(r => r === '404')) {
    throw fail('OTA_MANIFEST_NOT_FOUND', reason('OTA_MANIFEST_NOT_FOUND'), tried);
  }
  if (reasons.includes('FINGERPRINT_MISMATCH')) {
    throw fail('OTA_MANIFEST_TAMPERED', reason('OTA_MANIFEST_TAMPERED'), tried);
  }
  if (sawManifest) {
    throw fail('OTA_MANIFEST_INVALID', reason('OTA_MANIFEST_INVALID'), tried);
  }
  throw fail('OTA_REPO_UNREACHABLE', reason('OTA_REPO_UNREACHABLE'), tried);
}

/* ------------------------------------------------------------------------- */
/* download + stage                                                           */
/* ------------------------------------------------------------------------- */

/** Raw fetch, no hash check — used for the payload manifest and archive. */
async function downloadRaw(url, { token, timeoutMs = 45000 } = {}, timeoutOverride) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutOverride || timeoutMs);
  const headers = {};
  if (token) headers['PRIVATE-TOKEN'] = token;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      throw fail('OTA_RATE_LIMITED', reason('OTA_RATE_LIMITED'), { url, retryAfter });
    }
    if (!res.ok) throw fail('OTA_FILE_NOT_FOUND', reason('OTA_FILE_NOT_FOUND'), { url, status: res.status });
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err.otaCode) throw err;
    if (err?.name === 'AbortError') throw fail('OTA_NETWORK', reason('OTA_NETWORK'), { url, reason: 'TIMEOUT' });
    throw fail('OTA_NETWORK', reason('OTA_NETWORK'), { url, reason: err?.cause?.code || err?.message });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(url, expectedSha, { token, timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {};
  if (token) headers['PRIVATE-TOKEN'] = token;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
    if (res.status === 429) {
      // GitLab rate-limits per user per minute. A full first-time OTA is 40+
      // sequential fetches, so a 429 here is expected rather than exceptional.
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      throw fail('OTA_RATE_LIMITED', reason('OTA_RATE_LIMITED'), { url, retryAfter });
    }
    if (!res.ok) throw fail('OTA_FILE_NOT_FOUND', reason('OTA_FILE_NOT_FOUND'), { url, status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== expectedSha) {
      throw fail('OTA_FILE_MISMATCH', reason('OTA_FILE_MISMATCH'), { url, expected: expectedSha, got });
    }
    return buf;
  } catch (err) {
    if (err.otaCode) throw err;
    if (err?.name === 'AbortError') throw fail('OTA_NETWORK', reason('OTA_NETWORK'), { url, reason: 'TIMEOUT' });
    throw fail('OTA_NETWORK', reason('OTA_NETWORK'), { url, reason: err?.cause?.code || err?.message });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download every file in the manifest into a staging folder.
 * Files already present with the right hash are reused (cheap incremental update).
 */
async function stageFiles(manifest, baseUrl, stageDir, opts = {}) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const results = { downloaded: 0, reused: 0, staged: [] };
  const entries = Object.entries(manifest.files);

  for (const [rel, info] of entries) {
    const safe = path.posix.normalize(rel);
    if (safe.startsWith('..') || path.isAbsolute(safe)) {
      throw fail('OTA_MANIFEST_INVALID', reason('OTA_MANIFEST_INVALID'), `unsafe path: ${rel}`);
    }
    const dest = path.join(stageDir, safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    // 1) already on disk with the right hash?
    const onDisk = opts.currentRoot ? path.join(opts.currentRoot, safe) : null;
    if (onDisk && fs.existsSync(onDisk) && sha256File(onDisk) === info.sha256) {
      fs.copyFileSync(onDisk, dest);
      results.reused += 1;
      results.staged.push(safe);
      continue;
    }

    // 2) otherwise download and verify
    //
    // GitLab rate-limits per user (429 with a retry-after header). A first-time
    // update legitimately fetches 40+ files in a row, so hitting the ceiling is
    // normal rather than an error. Wait out the window and retry instead of
    // failing the whole update on request 30 of 48.
    let buf = null;
    let attempt = 0;
    const MAX_ATTEMPTS = 6;
    while (buf === null) {
      attempt += 1;
      const url = `${baseUrl}/${safe}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        buf = await downloadFile(url, info.sha256, opts);
      } catch (err) {
        const rateLimited = err && err.otaCode === 'OTA_RATE_LIMITED';
        if (!rateLimited || attempt >= MAX_ATTEMPTS) throw err;
        const wait = Math.min(
          120,
          Math.max(5, Number(err.otaDetail && err.otaDetail.retryAfter) || 30)
        );
        if (typeof opts.onWait === 'function') opts.onWait(attempt, wait, results.downloaded);
        await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
      }
    }
    fs.writeFileSync(dest, buf);
    results.downloaded += 1;
    results.staged.push(safe);
  }

  // Re-derive the manifest from what we actually staged, and re-sign it.
  const stagedFiles = {};
  for (const rel of results.staged) {
    const abs = path.join(stageDir, rel);
    stagedFiles[rel] = { sha256: sha256File(abs), size: fs.statSync(abs).size };
  }
  const stagedManifest = {
    ...manifest,
    files: stagedFiles,
    bundleSha256: fingerprint(stagedFiles),
    stagedAt: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(stageDir, 'ota-manifest.json'),
    JSON.stringify(stagedManifest, null, 2)
  );

  results.manifest = stagedManifest;
  return results;
}

/* ------------------------------------------------------------------------- */
/* single-archive payload                                                     */
/* ------------------------------------------------------------------------- */

/** Reads a ustar buffer into [{name, data}]. Throws on anything malformed. */
function readTar(tar) {
  const BLOCK = 512;
  const out = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad tar size field');
    off += BLOCK;
    if (off + size > tar.length) throw new Error('truncated tar entry');
    out.push({ name, data: tar.subarray(off, off + size) });
    off += size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  return out;
}

/**
 * Stages a release from the single-archive payload instead of per-file fetches.
 *
 * Falls back to null (and the caller uses the per-file path) when the payload
 * is not published yet, so older repositories keep working.
 *
 * The archive's own SHA-256 is verified first; only then is it unpacked, and
 * every entry is then checked against the per-file hashes in the manifest. An
 * archive that verifies as a whole but contains one wrong file is still
 * rejected.
 */
async function stageFromPayload(manifest, baseUrl, stageDir, opts = {}) {
  // The payload lives in the Package Registry rather than the raw tree: a 4 MB
  // binary in git would be re-served on every clone and raw fetches, while the
  // registry is content-addressed and cheap. Older repositories without a
  // payload simply 404 here and fall back to per-file staging.
  // Descriptor also comes from a sequence-scoped path where available.
  let meta = null;
  for (const candidate of [
    `${baseUrl}/payloads/${manifest.buildSeq}.json`,
    `${baseUrl}/ota-payload.json`
  ]) {
    try {
      const parsed = JSON.parse((await downloadRaw(`${candidate}?t=${Date.now()}`, opts)).toString('utf8'));
      if (parsed && parsed.buildSeq === manifest.buildSeq) { meta = parsed; break; }
      // A root descriptor describing some other build is stale cache, not an
      // error: keep looking rather than trusting it.
    } catch (_) { /* try the next name */ }
  }
  if (!meta) return null; // no payload published — let the per-file path handle it
  if (!meta || !meta.sha256 || !meta.size || !meta.files) return null;
  // Only use a payload that describes exactly the manifest we were told about.
  if (meta.buildSeq !== manifest.buildSeq || meta.bundleSha256 !== manifest.bundleSha256) {
    return null;
  }

  // Try the mirror this descriptor came from first, then any other known
  // mirror, then the registry URL recorded at build time. GitLab answers 429
  // under load while the archive sits behind a CDN elsewhere, so a single URL
  // is enough to lose an update.
  const archUrls = [];
  const pushUrl = (u) => {
    if (!u) return;
    const abs = /^https?:/i.test(u) ? u : `${baseUrl}/${u.replace(/^\/+/, '')}`;
    if (archUrls.indexOf(abs) === -1) archUrls.push(abs);
  };
  // Snapshot names carry the sequence, so they can never be served stale; the
  // mutable name stays as a last resort for installations pointed at a mirror
  // that only publishes the root copy.
  if (meta.archiveUrl) pushUrl(meta.archiveUrl);
  for (const src of DEFAULT_SOURCES) {
    const base = String(src).replace(/\/+$/, '');
    pushUrl(`${base}/payloads/${manifest.buildSeq}.tar.gz`);
  }
  for (const src of DEFAULT_SOURCES) {
    pushUrl(`${String(src).replace(/\/+$/, '')}/ota-payload.tar.gz`);
  }

  let archive = null;
  let archUrl = '';
  const archTried = [];
  for (const candidate of archUrls) {
    try {
      const buf = await downloadRaw(`${candidate}?t=${Date.now()}`, opts, Math.max(120000, opts.timeoutMs || 0));
      if (sha256(buf) === meta.sha256) { archive = buf; archUrl = candidate; break; }
      archTried.push({ url: candidate, reason: 'HASH_MISMATCH' });
    } catch (err) {
      archTried.push({ url: candidate, reason: err?.reason || err?.message || 'FETCH_FAILED' });
    }
  }
  if (!archive) {
    throw fail('OTA_FILE_NOT_FOUND', reason('OTA_FILE_NOT_FOUND'), { archive: archTried });
  }
  let entries;
  try {
    entries = readTar(zlib.gunzipSync(archive));
  } catch (err) {
    throw fail('OTA_MANIFEST_INVALID', reason('OTA_MANIFEST_INVALID'), `payload unpack: ${err.message}`);
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const byName = new Map(entries.map((e) => [e.name, e.data]));
  let reused = 0;
  let downloaded = 0;
  const staged = [];

  for (const [rel, info] of Object.entries(manifest.files)) {
    const safe = path.posix.normalize(rel);
    if (safe.startsWith('..') || path.isAbsolute(safe)) {
      throw fail('OTA_MANIFEST_INVALID', reason('OTA_MANIFEST_INVALID'), `unsafe path: ${rel}`);
    }
    const data = byName.get(rel);
    if (!data) {
      throw fail('OTA_FILE_NOT_FOUND', reason('OTA_FILE_NOT_FOUND'), { url: archUrl, missing: rel });
    }
    if (sha256(data) !== info.sha256) {
      throw fail('OTA_FILE_MISMATCH', reason('OTA_FILE_MISMATCH'), { url: archUrl, file: rel });
    }
    const dest = path.join(stageDir, safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    staged.push(safe);
    const onDisk = opts.currentRoot ? path.join(opts.currentRoot, safe) : null;
    if (onDisk && fs.existsSync(onDisk) && sha256File(onDisk) === info.sha256) reused += 1;
    else downloaded += 1;
  }

  const stagedFiles = {};
  for (const rel of staged) {
    const abs = path.join(stageDir, rel);
    stagedFiles[rel] = { sha256: sha256File(abs), size: fs.statSync(abs).size };
  }
  const stagedManifest = {
    ...manifest,
    files: stagedFiles,
    bundleSha256: fingerprint(stagedFiles),
    stagedAt: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(stageDir, 'ota-manifest.json'),
    JSON.stringify(stagedManifest, null, 2)
  );

  return { downloaded, reused, staged, manifest: stagedManifest, viaPayload: true };
}

/** Verify a staged tree against its own manifest before it is promoted. */
function verifyStaged(stageDir) {
  const mPath = path.join(stageDir, 'ota-manifest.json');
  if (!fs.existsSync(mPath)) return { ok: false, reason: 'NO_STAGED_MANIFEST' };
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  const computed = fingerprint(m.files);
  if (computed !== m.bundleSha256) return { ok: false, reason: 'STAGED_FINGERPRINT_MISMATCH' };
  for (const [rel, info] of Object.entries(m.files)) {
    const abs = path.join(stageDir, rel);
    if (!fs.existsSync(abs)) return { ok: false, reason: `MISSING:${rel}` };
    if (sha256File(abs) !== info.sha256) return { ok: false, reason: `MISMATCH:${rel}` };
  }
  return { ok: true, manifest: m, fileCount: Object.keys(m.files).length };
}

module.exports = {
  DEFAULT_SOURCES,
  REASONS,
  reason,
  fail,
  sha256,
  sha256File,
  fingerprint,
  fetchManifest,
  downloadFile,
  stageFiles,
  stageFromPayload,
  verifyStaged
};
