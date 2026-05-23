require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

// Local Expo app folder — edit here or set EXPO_PROJECT_PATH in .env
const EXPO_PROJECT_PATH =
  process.env.EXPO_PROJECT_PATH || path.join(__dirname, 'expo-app');

// Per-tenant icon store — persists uploaded icons so rebuild doesn't require re-upload
const CLIENT_ICONS_DIR = path.join(__dirname, 'client-icons');

// Per-tenant logo store — served as public static files so the Expo app can fetch by URL
const CLIENT_LOGOS_DIR = path.join(__dirname, 'public', 'client-logos');

// Per-tenant background image store
const CLIENT_BACKGROUNDS_DIR = path.join(__dirname, 'public', 'client-backgrounds');

// Per-tenant gallery image store
const CLIENT_GALLERIES_DIR = path.join(__dirname, 'public', 'client-galleries');

const PORT = Number(process.env.PORT) || 3000;

// Public base URL for generating absolute asset URLs (used in logo_url saved to DB).
// Public URL of THIS Node.js server — used to build absolute logo URLs stored in the DB.
// Must be set explicitly in .env (e.g. SERVER_BASE_URL=https://builder.manageapp.in).
// Falls back to stripping /api from PHP_API_BASE, then localhost.
// NOTE: do NOT derive from PREVIEW_URL — the preview may be on a different subdomain.
const SERVER_BASE_URL = (
  process.env.SERVER_BASE_URL ||
  (process.env.PHP_API_BASE || '').replace(/\/api\/?$/, '') ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const uploadBuild = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 40,
    parts: 120,
  },
}).fields([
  { name: 'appIcon', maxCount: 1 },
  { name: 'loginLogo', maxCount: 1 },
  { name: 'backgroundImage', maxCount: 1 },
  { name: 'galleryImages', maxCount: 20 },
]);

const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('logo');

const uploadIcon = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('icon');

const uploadBg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('bg_image');

const uploadGalleryItem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('gallery_image');

function isImageMime(m) {
  return typeof m === 'string' && m.startsWith('image/');
}

function extForImage(file) {
  const fromName = path.extname(file.originalname || '').toLowerCase();
  if (/^\.(jpe?g|png|gif|webp|bmp)$/i.test(fromName)) return fromName;
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
  };
  return map[file.mimetype] || '.img';
}

/** Relative path with forward slashes (Expo / app.config) */
function posixRel(segments) {
  return path.join(...segments).split(path.sep).join('/');
}

/** מוחק קבצי background-image.* מתיקיית assets של פרויקט האקספו */
function removeExpoBackgroundImageFiles(assetsDir) {
  try {
    if (!fs.existsSync(assetsDir)) return;
    const entries = fs.readdirSync(assetsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (/^background-image\.[^.]+$/i.test(ent.name)) {
        fs.unlinkSync(path.join(assetsDir, ent.name));
      }
    }
  } catch (e) {
    console.error('[build-app] removeExpoBackgroundImageFiles:', e);
  }
}

/** ערכי טופס כמו '1', 'true' — הסרת רקע / לוגו */
function isTruthyFormFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

const pool = require('./config/database');

async function runMigrations() {
  const stmts = [
    "ALTER TABLE businesses ADD COLUMN IF NOT EXISTS client_name VARCHAR(255) NULL",
    "ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL",
    "ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notes TEXT NULL",
    "ALTER TABLE businesses ADD COLUMN IF NOT EXISTS app_description_short VARCHAR(80) NULL",
    "ALTER TABLE businesses ADD COLUMN IF NOT EXISTS app_description_long TEXT NULL",
    "ALTER TABLE businesses ADD COLUMN IF NOT EXISTS keywords TEXT NULL",
    "ALTER TABLE businesses ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'draft'",
  ];
  for (const sql of stmts) {
    try { await pool.query(sql); } catch (e) { console.warn('[migration]', e.message); }
  }
  console.log('[migration] schema OK');
}

// ─── Auth config ──────────────────────────────────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET      || 'change-me-in-production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME  || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD  || 'admin123';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// ─── Auth middleware ───────────────────────────────────────────────────────────
// req.path inside app.use('/api', fn) is relative to /api, so /api/login → /login
function requireAuth(req, res, next) {
  const PUBLIC = ['/login', '/logout', '/auth/status', '/config'];
  if (PUBLIC.includes(req.path)) return next();
  // Logo, background, and gallery images are loaded by the Expo app — must be public
  if (req.method === 'GET' && /^\/clients\/[^/]+\/(logo|background)$/.test(req.path)) return next();
  if (req.method === 'GET' && /^\/clients\/[^/]+\/gallery(\/[^/]+)?$/.test(req.path)) return next();
  // Gallery write ops are called from the React app - open auth so uploads reach the Node handler
  if (/^\/clients\/[^/]+\/gallery(\/[^/]+)?$/.test(req.path)) return next();
  const token = req.cookies.authToken;
  if (!token) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('authToken');
    res.status(401).json({ status: 'error', message: 'Session expired' });
  }
}
app.use('/api', requireAuth);

// Pre-auth probe — fires for every /api/clients/*/gallery* request so we can confirm
// the request reaches Node.js regardless of auth outcome.
app.use('/api/clients/:id/gallery', (req, _res, next) => {
  console.log(`[gallery PROBE] ${req.method} /api/clients/${req.params.id}/gallery${req.path === '/' ? '' : req.path} — content-type: ${req.headers['content-type'] || 'none'}`);
  next();
});

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ status: 'error', message: 'שם משתמש או סיסמה שגויים' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('authToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ status: 'success', username });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie('authToken');
  res.json({ status: 'success' });
});

app.get('/api/auth/status', (req, res) => {
  const token = req.cookies.authToken;
  if (!token) return res.status(401).json({ status: 'error', message: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ status: 'success', username: decoded.username });
  } catch {
    res.clearCookie('authToken');
    res.status(401).json({ status: 'error', message: 'Session expired' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

const PHP_API_BASE = (process.env.PHP_API_BASE || '').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

/**
 * Fire-and-forget sync of image URLs from the Node.js DB to the PHP DB.
 *
 * Node.js (builder.manageapp.in) and PHP (manageapp.in) run on separate
 * servers with separate MySQL instances.  Any write to the Node.js DB is
 * invisible to PHP's get_business_config.php — so after a dashboard upload
 * the Expo app's refreshFromApi() still returns bgImageUri: null and the
 * preview clears the background.
 *
 * This helper calls update_business_config.php (PHP-side DB) whenever
 * logo_url or bg_image_url changes, keeping both DBs in sync.
 *
 * `fields` example: { logoUri: 'https://...' } or { bgImageUri: null }
 */
async function syncImageUrlsToPhp(tenantId, fields) {
  if (!PHP_API_BASE || !ADMIN_API_TOKEN) return;
  try {
    const r = await fetch(`${PHP_API_BASE}/update_business_config.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${ADMIN_API_TOKEN}`,
      },
      body: JSON.stringify({ tenant_id: tenantId, ...fields }),
    });
    const text = await r.text();
    console.log(`[syncImageUrlsToPhp] tenant=${tenantId} fields=${JSON.stringify(fields)} status=${r.status} body=${text.slice(0, 120)}`);
  } catch (e) {
    console.error('[syncImageUrlsToPhp] fetch error:', e.message);
  }
}

async function proxyPhpScript(scriptName, req, res) {
  if (!PHP_API_BASE || !ADMIN_API_TOKEN) {
    return res.status(503).json({
      status: 'error',
      message:
        'Set PHP_API_BASE (backend/api URL, no trailing slash) and ADMIN_API_TOKEN in .env',
    });
  }
  const url = `${PHP_API_BASE}/${scriptName.replace(/^\//, '')}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${ADMIN_API_TOKEN}`,
      },
      body: JSON.stringify(req.body ?? {}),
    });
    const text = await r.text();
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      res.status(r.status).type('application/json; charset=utf-8').send(text);
    } else {
      res.status(r.status).type('text/plain').send(text);
    }
  } catch (e) {
    console.error(`[proxy ${scriptName}]`, e);
    res.status(502).json({
      status: 'error',
      message: e instanceof Error ? e.message : 'Proxy error',
    });
  }
}

app.post('/api/create_business.php', (req, res) => {
  proxyPhpScript('create_business.php', req, res);
});

app.post('/api/update_business_config.php', (req, res) => {
  proxyPhpScript('update_business_config.php', req, res);
});

app.post('/api/build-app', uploadBuild, (req, res) => {
  const {
    appName,
    tenantId,
    bundleId,
    brandPreset,
    businessType,
    removeBackgroundImage,
    businessName,
    removeLogo,
  } = req.body || {};

  if (!tenantId || String(tenantId).trim() === '') {
    return res.status(400).json({
      status: 'error',
      message: 'tenantId is required',
    });
  }

  const uploaded = req.files || {};
  const appIconFile = uploaded.appIcon && uploaded.appIcon[0];
  const loginLogoFile = uploaded.loginLogo && uploaded.loginLogo[0];
  const backgroundFile = uploaded.backgroundImage && uploaded.backgroundImage[0];
  let galleryFiles = uploaded.galleryImages || [];
  if (!Array.isArray(galleryFiles)) {
    galleryFiles = galleryFiles ? [galleryFiles] : [];
  }

  const assetsDir = path.join(EXPO_PROJECT_PATH, 'assets');
  const storedIconPath = path.join(CLIENT_ICONS_DIR, `${String(tenantId).trim()}.png`);

  const removeBgRequested = isTruthyFormFlag(removeBackgroundImage);
  /** הסרת לוגו פנימי בלבד (מסך התחברות) — לא משנה אייקון חנויות */
  const removeLoginLogoRequested = isTruthyFormFlag(removeLogo);

  if (appIconFile) {
    // New icon uploaded — validate, persist per-tenant, and copy to Expo assets
    if (appIconFile.mimetype !== 'image/png') {
      return res.status(400).json({
        status: 'error',
        message: 'Icon must be a PNG image',
      });
    }
    fs.mkdirSync(CLIENT_ICONS_DIR, { recursive: true });
    fs.writeFileSync(storedIconPath, appIconFile.buffer);
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'icon.png'), appIconFile.buffer);
    fs.writeFileSync(path.join(assetsDir, 'adaptive-icon.png'), appIconFile.buffer);
  } else if (fs.existsSync(storedIconPath)) {
    // No new upload — reuse the icon stored from the last build for this tenant
    const storedBuffer = fs.readFileSync(storedIconPath);
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'icon.png'), storedBuffer);
    fs.writeFileSync(path.join(assetsDir, 'adaptive-icon.png'), storedBuffer);
  } else {
    return res.status(400).json({
      status: 'error',
      message: 'אייקון אפליקציה (PNG 1024×1024) הוא שדה חובה לבנייה ראשונה',
    });
  }

  const loginLogoPath = path.join(assetsDir, 'login-logo.png');
  if (loginLogoFile) {
    if (loginLogoFile.mimetype !== 'image/png') {
      return res.status(400).json({
        status: 'error',
        message: 'Login logo must be a PNG image',
      });
    }
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(loginLogoPath, loginLogoFile.buffer);
  } else if (removeLoginLogoRequested) {
    try {
      if (fs.existsSync(loginLogoPath)) fs.unlinkSync(loginLogoPath);
    } catch (e) {
      console.error('[build-app] remove login-logo.png:', e);
    }
  }

  let backgroundRelative = null;
  if (backgroundFile) {
    if (!isImageMime(backgroundFile.mimetype)) {
      return res.status(400).json({
        status: 'error',
        message: 'Background must be an image file',
      });
    }
    fs.mkdirSync(assetsDir, { recursive: true });
    const ext = extForImage(backgroundFile);
    const fname = `background-image${ext}`;
    fs.writeFileSync(path.join(assetsDir, fname), backgroundFile.buffer);
    backgroundRelative = posixRel(['assets', fname]);
  } else if (removeBgRequested) {
    fs.mkdirSync(assetsDir, { recursive: true });
    removeExpoBackgroundImageFiles(assetsDir);
  }

  const galleryRelativePaths = [];
  if (galleryFiles.length > 0) {
    for (let i = 0; i < galleryFiles.length; i++) {
      if (!isImageMime(galleryFiles[i].mimetype)) {
        return res.status(400).json({
          status: 'error',
          message: 'All gallery files must be images',
        });
      }
    }
    const galleryDir = path.join(assetsDir, 'gallery');
    fs.rmSync(galleryDir, { recursive: true, force: true });
    fs.mkdirSync(galleryDir, { recursive: true });
    galleryFiles.forEach((f, index) => {
      const ext = extForImage(f);
      const fname = `gallery-${index}${ext}`;
      fs.writeFileSync(path.join(galleryDir, fname), f.buffer);
      galleryRelativePaths.push(posixRel(['assets', 'gallery', fname]));
    });
  }

  const buildEnv = {
    ...process.env,
    APP_NAME: appName != null ? String(appName) : process.env.APP_NAME,
    TENANT_ID: String(tenantId),
    BUNDLE_ID: bundleId != null ? String(bundleId) : process.env.BUNDLE_ID,
    BRAND_PRESET:
      brandPreset != null && String(brandPreset).trim() !== ''
        ? String(brandPreset).trim()
        : process.env.BRAND_PRESET || 'classic_modern',
    BUSINESS_TYPE:
      businessType != null ? String(businessType) : process.env.BUSINESS_TYPE,
    BUSINESS_NAME:
      businessName != null ? String(businessName).trim() : (process.env.BUSINESS_NAME ?? ''),
  };

  if (backgroundRelative) {
    buildEnv.BACKGROUND_IMAGE_PATH = backgroundRelative;
    buildEnv.BACKGROUND_IMAGE_FILENAME = path.posix.basename(backgroundRelative);
  } else if (removeBgRequested) {
    delete buildEnv.BACKGROUND_IMAGE_PATH;
    delete buildEnv.BACKGROUND_IMAGE_FILENAME;
  }
  if (galleryRelativePaths.length > 0) {
    const galleryBasenames = galleryRelativePaths.map((p) => path.posix.basename(p));
    buildEnv.GALLERY_IMAGE_PATHS = galleryRelativePaths.join(',');
    buildEnv.GALLERY_IMAGE_FILENAMES = galleryBasenames.join(',');
    buildEnv.GALLERY_IMAGE_COUNT = String(galleryRelativePaths.length);
  }

  const args = [
    'build',
    '--platform',
    'android',
    '--profile',
    'production',
    '--non-interactive',
  ];

  const shell = process.platform === 'win32';
  const child = spawn('eas', args, {
    cwd: EXPO_PROJECT_PATH,
    env: buildEnv,
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[EAS build tenant=${tenantId}]`;
  child.stdout.on('data', (chunk) => {
    process.stdout.write(`${prefix} ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`${prefix} ${chunk}`);
  });
  child.on('error', (err) => {
    console.error(`${prefix} spawn error:`, err);
  });
  child.on('close', (code, signal) => {
    console.log(`${prefix} exited with code ${code}${signal ? ` signal ${signal}` : ''}`);
  });

  return res.json({
    status: 'success',
    message: 'Build process started on EAS',
    tenantId: String(tenantId),
  });
});

app.post('/api/delete_business', async (req, res) => {
  const tenantId = String(req.body?.tenant_id ?? '').trim();
  if (!tenantId) {
    return res.status(400).json({ status: 'error', message: 'tenant_id is required' });
  }
  try {
    const [result] = await pool.query('DELETE FROM businesses WHERE tenant_id = ?', [tenantId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ status: 'error', message: 'Business not found' });
    }
    return res.json({ status: 'success', tenant_id: tenantId });
  } catch (e) {
    console.error('[delete_business]', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/push-update', async (req, res) => {
  const tenantId = String(req.body?.tenant_id ?? '').trim();
  const message = String(req.body?.message ?? '').trim();
  const updateType = String(req.body?.update_type ?? 'ota').trim();

  if (!tenantId) {
    return res.status(400).json({ status: 'error', message: 'tenant_id is required' });
  }
  if (!message) {
    return res.status(400).json({ status: 'error', message: 'message is required' });
  }

  try {
    const [rows] = await pool.query('SELECT id FROM businesses WHERE tenant_id = ? LIMIT 1', [tenantId]);
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: `Business '${tenantId}' not found` });
    }
  } catch (e) {
    console.error('[push-update] db lookup:', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  const logUpdate = async (status, output = null) => {
    try {
      await pool.query(
        'INSERT INTO update_history (tenant_id, message, type, status, output, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [tenantId, message, updateType, status, output ? output.slice(0, 4000) : null]
      );
    } catch (e) {
      console.error('[push-update] log insert:', e);
    }
  };

  if (updateType === 'full_build') {
    await logUpdate('skipped');
    return res.json({
      status: 'success',
      message: 'Full build not yet implemented — coming soon!',
      tenant_id: tenantId,
    });
  }

  const safeMessage = message.replace(/"/g, '\\"');
  const cmd = `eas update --branch ${tenantId} --message "${safeMessage}" --non-interactive`;
  const prefix = `[push-update tenant=${tenantId}]`;
  console.log(`${prefix} running: ${cmd}`);

  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: EXPO_PROJECT_PATH });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    console.log(`${prefix} done\n${output}`);
    await logUpdate('success', output);
    return res.json({ status: 'success', tenant_id: tenantId, output });
  } catch (e) {
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
    console.error(`${prefix} failed\n${output}`);
    await logUpdate('error', output);
    return res.status(500).json({ status: 'error', message: 'EAS update failed', output });
  }
});

app.get('/update/:tenant_id', async (req, res) => {
  const tenantId = String(req.params.tenant_id).trim();

  let business = null;
  let dbError = null;
  try {
    const [rows] = await pool.query('SELECT * FROM businesses WHERE tenant_id = ? LIMIT 1', [tenantId]);
    business = rows[0] ?? null;
  } catch (e) {
    console.error('[update page]', e);
    dbError = e.message;
  }

  if (!dbError && !business) {
    return res.status(404).send('<h2 style="font-family:sans-serif;color:#f87171;padding:2rem">עסק לא נמצא</h2>');
  }

  const escape = (s) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const businessName = business ? escape(business.business_name) || escape(tenantId) : escape(tenantId);
  const tenantSafe   = escape(tenantId);

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>עדכון — ${businessName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"/>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script>tailwind.config={theme:{extend:{fontFamily:{sans:['Assistant','sans-serif']}}}}<\/script>
  <style>/* keep has-[:checked] working in all CDN builds */
</style>
</head>
<body class="min-h-screen bg-[#0B0F19] text-slate-100 antialiased font-sans selection:bg-indigo-500/30">

<!-- NAV -->
<nav class="sticky top-0 z-50 border-b border-white/5 bg-[#0B0F19]/95 backdrop-blur-xl">
  <div class="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
    <div class="flex items-center gap-3">
      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-violet-600 shadow-[0_0_20px_-5px_rgba(99,102,241,0.5)]">
        <svg class="h-4 w-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/>
        </svg>
      </div>
      <a href="/" class="hidden font-bold text-white transition-colors hover:text-slate-300 sm:inline">App Factory Studio</a>
    </div>
    <div class="flex items-center gap-1.5 text-xs text-slate-500">
      <a href="/" class="transition-colors hover:text-indigo-400">לקוחות</a>
      <span class="text-slate-700">›</span>
      <span class="font-semibold text-slate-300">${businessName}</span>
      <span class="text-slate-700">›</span>
      <span>OTA Update</span>
    </div>
    <a href="/" class="rounded-xl border border-white/10 bg-white/5 px-4 py-1.5 text-sm font-semibold text-slate-300 transition hover:bg-white/10">← חזרה</a>
  </div>
</nav>

<!-- CONTENT -->
<div class="mx-auto max-w-2xl px-4 py-12 sm:px-6">

  <!-- Page header -->
  <div class="mb-10 text-center">
    <div class="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-[0_0_40px_-10px_rgba(139,92,246,0.6)] ring-1 ring-white/10">
      <svg class="h-8 w-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
      </svg>
    </div>
    <h1 class="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent">
      עדכון אפליקציה
    </h1>
    <p class="mt-2 text-sm text-slate-500">
      ${businessName}
      <span class="mx-1.5 text-slate-700">•</span>
      <code class="font-mono text-indigo-400/80">${tenantSafe}</code>
    </p>
  </div>

  ${dbError ? `<div class="mb-6 rounded-2xl border border-red-500/30 bg-red-950/50 px-5 py-4 text-sm text-red-300">שגיאת DB: ${escape(dbError)}</div>` : ''}

  <form id="update-form" class="space-y-5">
    <input type="hidden" name="tenant_id" value="${tenantSafe}"/>

    <!-- Update message -->
    <div class="rounded-3xl border border-white/10 bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <h2 class="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
        <span class="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/20 text-indigo-400">
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
        </span>
        הודעת עדכון
      </h2>
      <textarea name="message" rows="4" required
        placeholder="תאר את השינויים בעדכון זה…"
        class="w-full resize-y rounded-xl border border-white/10 bg-black/40 px-4 py-3.5 text-slate-100 outline-none transition-all duration-200 placeholder:text-slate-600 focus:border-indigo-500/50 focus:bg-black/60 focus:ring-4 focus:ring-indigo-500/10"></textarea>
    </div>

    <!-- Update type -->
    <div class="rounded-3xl border border-white/10 bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <h2 class="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
        <span class="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/20 text-violet-400">
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        </span>
        סוג עדכון
      </h2>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-4 transition-all has-[:checked]:border-indigo-500/50 has-[:checked]:bg-indigo-500/5">
          <input type="radio" name="update_type" value="ota" checked class="mt-0.5 shrink-0 accent-indigo-500"/>
          <div>
            <div class="text-sm font-semibold text-slate-200">עדכון OTA</div>
            <div class="mt-0.5 text-xs text-slate-500">מהיר • ללא הורדה מחדש</div>
          </div>
        </label>
        <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-4 transition-all has-[:checked]:border-indigo-500/50 has-[:checked]:bg-indigo-500/5">
          <input type="radio" name="update_type" value="full_build" class="mt-0.5 shrink-0 accent-indigo-500"/>
          <div>
            <div class="text-sm font-semibold text-slate-200">בנייה מלאה</div>
            <div class="mt-0.5 text-xs text-slate-500">גרסה חדשה בחנויות</div>
          </div>
        </label>
      </div>
    </div>

    <!-- Warning -->
    <div class="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-5 py-4">
      <span class="mt-0.5 shrink-0 text-lg">⚠️</span>
      <p class="text-sm text-amber-200/80">העדכון יגיע לכל המשתמשים תוך 5 דקות</p>
    </div>

    <!-- Status messages -->
    <div id="progress-box" style="display:none" class="flex items-center gap-3 rounded-2xl border border-indigo-500/25 bg-indigo-500/5 px-5 py-4">
      <div class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-indigo-500/30 border-t-indigo-400"></div>
      <span class="text-sm text-indigo-300">שולח עדכון…</span>
    </div>
    <div id="success-box" style="display:none" class="rounded-2xl border border-emerald-500/30 bg-emerald-950/50 px-5 py-4 text-sm font-medium text-emerald-200">
      ✓ העדכון נשלח בהצלחה!
    </div>
    <div id="error-box" style="display:none" class="rounded-2xl border border-red-500/30 bg-red-950/50 px-5 py-4 text-sm text-red-300"></div>

    <!-- Actions -->
    <div class="flex gap-3 pt-1">
      <a href="/" class="rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-sm font-semibold text-slate-300 transition hover:bg-white/10">← ביטול</a>
      <button type="submit" id="submit-btn"
        class="group relative flex flex-1 items-center justify-center gap-3 overflow-hidden rounded-xl bg-indigo-500 px-6 py-4 text-sm font-bold text-white transition-all duration-300 hover:bg-indigo-400 hover:shadow-[0_0_20px_rgba(99,102,241,0.4)] focus:outline-none focus:ring-4 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60">
        <div class="absolute inset-0 flex h-full w-full justify-center [transform:skew(-12deg)_translateX(-100%)] group-hover:duration-1000 group-hover:[transform:skew(-12deg)_translateX(100%)]">
          <div class="relative h-full w-8 bg-white/20"></div>
        </div>
        <span id="submit-label" class="relative">שלח עדכון</span>
        <svg id="submit-spinner" class="relative hidden h-4 w-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </button>
    </div>
  </form>
</div>

<script>
  document.getElementById('update-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var form          = e.target;
    var submitBtn     = document.getElementById('submit-btn');
    var submitLabel   = document.getElementById('submit-label');
    var submitSpinner = document.getElementById('submit-spinner');
    var progressBox   = document.getElementById('progress-box');
    var successBox    = document.getElementById('success-box');
    var errorBox      = document.getElementById('error-box');

    submitBtn.disabled = true;
    submitLabel.textContent = 'שולח…';
    submitSpinner.classList.remove('hidden');
    progressBox.style.display = 'flex';
    successBox.style.display  = 'none';
    errorBox.style.display    = 'none';

    try {
      var r = await fetch('/api/push-update', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          tenant_id:   form.tenant_id.value,
          message:     form.message.value,
          update_type: form.update_type.value,
        }),
      });
      var data = await r.json();
      progressBox.style.display = 'none';
      if (data.status === 'success') {
        successBox.style.display = 'block';
        form.reset();
      } else {
        errorBox.textContent    = 'שגיאה: ' + (data.message || 'העדכון נכשל');
        errorBox.style.display  = 'block';
      }
    } catch {
      progressBox.style.display = 'none';
      errorBox.textContent      = 'שגיאת רשת — נסה שוב';
      errorBox.style.display    = 'block';
    } finally {
      submitBtn.disabled          = false;
      submitLabel.textContent     = 'שלח עדכון';
      submitSpinner.classList.add('hidden');
    }
  });
<\/script>
</body>
</html>`;

  res.type('text/html').send(html);
});

// ─── Client Detail View ───────────────────────────────────────────────────────

app.get('/client/:tenant_id', (req, res) => res.redirect(`/update/${req.params.tenant_id}`));
if (false) (async (req, res) => {  // legacy — SPA handles this now
  const tenantId = String(req.params.tenant_id).trim();
  let business = null;
  let dbError = null;
  try {
    const [rows] = await pool.query('SELECT * FROM businesses WHERE tenant_id = ? LIMIT 1', [tenantId]);
    business = rows[0] ?? null;
  } catch (e) {
    console.error('[client detail]', e);
    dbError = e.message;
  }

  if (!dbError && !business) {
    return res.status(404).send('<h2 style="font-family:sans-serif;color:#f87171;padding:2rem">עסק לא נמצא</h2>');
  }

  const escape = (s) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const b = business || {};
  const displayName = escape(b.business_name || tenantId);

  const BRAND_PRESETS = ['classic_modern', 'premium_dark', 'beauty_nude'];
  const BUSINESS_TYPES = ['barber', 'cosmetician', 'massage', 'nails', 'physiotherapy', 'general'];

  function opt(arr, current, labels = {}) {
    return arr.map(v => `<option value="${v}"${v === current ? ' selected' : ''}>${labels[v] || v}</option>`).join('');
  }

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${displayName} — פרטי לקוח</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"/>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { theme: { extend: { fontFamily: { sans: ['Assistant','sans-serif'] } } } }</script>
</head>
<body class="min-h-screen bg-[#0B0F19] text-slate-100 antialiased font-sans" dir="rtl">
<div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-10">

  <!-- Header -->
  <div class="mb-8 flex items-center gap-4">
    <a href="/dashboard" class="flex items-center gap-2 text-sm text-slate-400 hover:text-indigo-400 transition-colors">
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
      חזרה לדשבורד
    </a>
    <span class="text-slate-700">|</span>
    <span class="text-sm text-slate-500">פרטי לקוח</span>
  </div>

  <div class="mb-8 flex flex-col gap-1">
    <h1 class="text-2xl font-extrabold text-white sm:text-3xl">${displayName}</h1>
    <p class="text-sm text-slate-500 font-mono">${escape(tenantId)}</p>
  </div>

  ${dbError ? `<div class="mb-6 rounded-xl bg-red-950/50 border border-red-500/30 px-4 py-3 text-sm text-red-300">שגיאת DB: ${escape(dbError)}</div>` : ''}

  <!-- Two-column layout -->
  <div class="flex flex-col gap-8 lg:grid lg:grid-cols-12 lg:items-start">

    <!-- ── Left: Edit Form ── -->
    <div class="lg:col-span-7 xl:col-span-8">
      <form id="client-form" class="space-y-5">
        <input type="hidden" name="tenant_id" value="${escape(tenantId)}"/>

        <!-- Basic Info -->
        <section class="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
          <h2 class="mb-5 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-400">
            <span class="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/20 text-indigo-400">
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </span>
            מידע בסיסי
          </h2>
          <div class="space-y-4">
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">שם העסק</label>
              <input name="business_name" type="text" value="${escape(b.business_name)}"
                class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-600"/>
            </div>
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">Tenant ID <span class="font-normal text-slate-600">(לא ניתן לשינוי)</span></label>
              <div class="flex items-center gap-2 rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <code class="text-sm text-indigo-400">${escape(tenantId)}</code>
              </div>
            </div>
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">סוג עסק</label>
              <select name="business_type" class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10">
                ${opt(BUSINESS_TYPES, b.business_type, { barber: 'מספרה / ספר', cosmetician: 'קוסמטיקה', massage: 'עיסוי', nails: 'ציפורניים / נייליסטית', physiotherapy: 'פיזיותרפיה', general: 'עסק כללי' })}
              </select>
            </div>
          </div>
        </section>

        <!-- Branding -->
        <section class="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
          <h2 class="mb-5 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-400">
            <span class="flex h-6 w-6 items-center justify-center rounded-md bg-pink-500/20 text-pink-400">
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
            </span>
            עיצוב ומיתוג
          </h2>
          <div class="space-y-4">
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">ערכת עיצוב (Brand Preset)</label>
              <select name="brand_preset" class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10">
                ${opt(BRAND_PRESETS, b.brand_preset, { classic_modern: 'קלאסי מודרני', premium_dark: 'פרימיום דארק', beauty_nude: 'ביוטי ניוד' })}
              </select>
            </div>
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">כתובת לוגו (Logo URL)</label>
              <input name="logo_url" type="url" value="${escape(b.logo_url)}" dir="ltr" placeholder="https://..."
                class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm font-mono text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-600"/>
            </div>
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">כתובת תמונת רקע (BG Image URL)</label>
              <input name="bg_image_url" type="url" value="${escape(b.bg_image_url)}" dir="ltr" placeholder="https://..."
                class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm font-mono text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-600"/>
            </div>
            <div>
              <label class="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-400">
                <span>עוצמת טשטוש רקע</span>
                <span id="blur-val" class="font-mono text-indigo-400">${Number(b.bg_blur_intensity ?? 22)}</span>
              </label>
              <input id="blur-range" name="bg_blur_intensity" type="range" min="0" max="100" value="${Number(b.bg_blur_intensity ?? 22)}"
                class="w-full h-2 rounded-full bg-slate-800 accent-indigo-500 cursor-pointer"
                oninput="document.getElementById('blur-val').textContent = this.value"/>
            </div>
          </div>
        </section>

        <!-- About & Contact -->
        <section class="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
          <h2 class="mb-5 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-400">
            <span class="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/20 text-emerald-400">
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
            </span>
            אודות ויצירת קשר
          </h2>
          <div class="space-y-4">
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">טקסט "אודות"</label>
              <textarea name="about_us_text" rows="3" placeholder="תיאור קצר על העסק..."
                class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-600 resize-y">${escape(b.about_us_text)}</textarea>
            </div>
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label class="mb-1.5 block text-xs font-semibold text-slate-400">טלפון</label>
                <input name="business_phone" type="tel" value="${escape(b.business_phone)}" dir="ltr" placeholder="05X-XXXXXXX"
                  class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-600"/>
              </div>
              <div>
                <label class="mb-1.5 block text-xs font-semibold text-slate-400">כתובת</label>
                <input name="business_address" type="text" value="${escape(b.business_address)}" placeholder="רחוב, עיר"
                  class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-600"/>
              </div>
            </div>
          </div>
        </section>

        <!-- Social Links -->
        <section class="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
          <h2 class="mb-5 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-400">
            <span class="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/20 text-violet-400">
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
            </span>
            רשתות חברתיות
          </h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            ${[
              ['social_instagram', 'Instagram', '📸'],
              ['social_facebook', 'Facebook', '👍'],
              ['social_tiktok', 'TikTok', '🎵'],
              ['social_website', 'אתר אינטרנט', '🌐'],
              ['social_whatsapp', 'WhatsApp', '💬'],
            ].map(([field, label, icon]) => `
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-400">${icon} ${label}</label>
              <input name="${field}" type="text" value="${escape(b[field])}" dir="ltr" placeholder="@username או URL"
                class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm font-mono text-slate-100 outline-none transition focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-600"/>
            </div>`).join('')}
          </div>
        </section>

        <!-- Save Button -->
        <div class="flex items-center gap-4">
          <button type="submit" id="save-btn"
            class="flex-1 rounded-xl bg-indigo-500 px-6 py-3.5 text-sm font-bold text-white transition hover:bg-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-50">
            שמור שינויים
          </button>
          <a href="/update/${escape(tenantId)}"
            class="rounded-xl border border-violet-500/30 bg-violet-500/10 px-5 py-3.5 text-sm font-semibold text-violet-300 transition hover:bg-violet-500/20">
            עדכון OTA
          </a>
        </div>

        <div id="save-result" class="hidden rounded-xl px-4 py-3 text-sm font-medium"></div>
      </form>
    </div>

    <!-- ── Right: Phone Preview ── -->
    <div class="lg:col-span-5 xl:col-span-4 lg:sticky lg:top-8 flex flex-col items-center">
      <div class="mb-4 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5">
        <span class="relative flex h-2.5 w-2.5">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
        </span>
        <span class="text-xs font-semibold text-slate-300">Live Preview</span>
      </div>

      <!-- Phone Mockup -->
      <div class="relative mx-auto shrink-0" style="width:calc(414px * 0.68); height:calc(896px * 0.68)">
        <div class="absolute left-1/2 top-0 origin-top -translate-x-1/2 scale-[0.68]">
          <div class="relative box-border h-[896px] w-[414px] overflow-hidden rounded-[3.5rem] border-[12px] border-slate-800 bg-slate-900 ring-1 ring-white/10 shadow-[0_40px_80px_-15px_rgba(0,0,0,0.8)]">
            <!-- Dynamic island -->
            <div class="absolute left-1/2 top-4 z-20 flex h-7 w-32 -translate-x-1/2 items-center justify-between rounded-full bg-black px-2.5 shadow-inner pointer-events-none">
              <div class="h-2.5 w-2.5 rounded-full bg-[#0a0a0a] shadow-[inset_0px_0px_2px_rgba(255,255,255,0.1)]"></div>
              <div class="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-800/60">
                <div class="h-1.5 w-1.5 rounded-full bg-slate-600/80"></div>
              </div>
            </div>
            <!-- Screen: live iframe -->
            <div class="h-full w-full overflow-hidden rounded-[2.5rem] bg-black">
              <iframe
                id="preview-frame"
                src="/app/?tenant_id=${tenantSafe}"
                class="h-full w-full border-0"
                title="Live App Preview"
                allow="cross-origin-isolated"
              ></iframe>
            </div>
            <!-- Bottom home-bar -->
            <div class="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 h-1 w-28 rounded-full bg-slate-700/60 pointer-events-none"></div>
          </div>
        </div>
      </div>

      <p class="mt-5 text-center text-xs text-slate-600 leading-relaxed">
        מציג את <span class="font-mono text-slate-500">builder.manageapp.in/app/</span>
      </p>
    </div>

  </div>
</div>

<script>
  document.getElementById('client-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('save-btn');
    const result = document.getElementById('save-result');
    btn.disabled = true;
    btn.textContent = 'שומר...';

    const data = {};
    new FormData(this).forEach((v, k) => { data[k] = v; });

    try {
      const r = await fetch('/api/client/${escape(tenantId)}/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await r.json().catch(() => ({}));
      result.classList.remove('hidden', 'bg-emerald-950/50', 'border-emerald-500/30', 'text-emerald-200', 'bg-red-950/50', 'border-red-500/30', 'text-red-300', 'border');
      result.classList.add('border');
      if (r.ok && json.status === 'success') {
        result.classList.add('bg-emerald-950/50', 'border-emerald-500/30', 'text-emerald-200');
        result.textContent = '✓ השינויים נשמרו בהצלחה';
      } else {
        result.classList.add('bg-red-950/50', 'border-red-500/30', 'text-red-300');
        result.textContent = '✗ ' + (json.message || 'שגיאה בשמירה (' + r.status + ')');
      }
    } catch (err) {
      result.classList.remove('hidden');
      result.classList.add('border', 'bg-red-950/50', 'border-red-500/30', 'text-red-300');
      result.textContent = '✗ שגיאת רשת — ודא שהשרת פועל';
    } finally {
      btn.disabled = false;
      btn.textContent = 'שמור שינויים';
      result.classList.remove('hidden');
    }
  });

  // ── Live Preview via postMessage ────────────────────────────────────────────
  (function () {
    const frame = document.getElementById('preview-frame');

    function getPayload() {
      const fd = new FormData(document.getElementById('client-form'));
      const get = k => (fd.get(k) || '').trim();
      const val = (v) => v.length > 0 ? v : null;
      return {
        appName:         get('business_name') || undefined,
        businessName:    get('business_name') || undefined,
        businessType:    get('business_type') || undefined,
        brandPreset:     get('brand_preset')  || undefined,
        logoUri:         val(get('logo_url')),
        bgImageUri:      val(get('bg_image_url')),
        bgBlurIntensity: Number(get('bg_blur_intensity') || 22),
        aboutUsText:     get('about_us_text'),
        businessPhone:   val(get('business_phone')),
        businessAddress: val(get('business_address')),
        socialInstagram: val(get('social_instagram')),
        socialFacebook:  val(get('social_facebook')),
        socialTiktok:    val(get('social_tiktok')),
        socialWebsite:   val(get('social_website')),
        socialWhatsapp:  val(get('social_whatsapp')),
      };
    }

    function sendPreview() {
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage({ type: 'UPDATE_PREVIEW', payload: getPayload() }, '*');
    }

    // Debounce: wait 300 ms after user stops typing before sending
    let debounceTimer;
    function sendDebounced() { clearTimeout(debounceTimer); debounceTimer = setTimeout(sendPreview, 300); }

    // Fire on every keystroke / select change / slider move
    document.getElementById('client-form').addEventListener('input',  sendDebounced);
    document.getElementById('client-form').addEventListener('change', sendDebounced);

    // Push current form state into the iframe once it finishes loading
    frame.addEventListener('load', function () {
      setTimeout(sendPreview, 600);
    });
  })();
</script>
</body>
</html>`;

  res.type('text/html').send(html);
});

// ─── Client Update API ────────────────────────────────────────────────────────

app.post('/api/client/:tenant_id/update', async (req, res) => {
  const tenantId = String(req.params.tenant_id).trim();
  if (!tenantId) {
    return res.status(400).json({ status: 'error', message: 'tenant_id is required' });
  }

  const {
    business_name, business_type, brand_preset,
    logo_url, bg_image_url, bg_blur_intensity,
    about_us_text, business_phone, business_address,
    social_instagram, social_facebook, social_tiktok, social_website, social_whatsapp,
    client_name, phone, notes,
    app_description_short, app_description_long, keywords, status,
  } = req.body || {};

  const blurInt = parseInt(bg_blur_intensity ?? '', 10);
  const blurVal = Number.isFinite(blurInt) ? Math.min(100, Math.max(0, blurInt)) : 22;
  const VALID_STATUSES = ['draft', 'in_progress', 'live'];
  const statusVal = VALID_STATUSES.includes(status) ? status : null;

  const nullOrStr = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

  try {
    const [result] = await pool.query(
      `UPDATE businesses SET
        business_name = ?,
        business_type = ?,
        brand_preset = ?,
        logo_url = ?,
        bg_image_url = ?,
        bg_blur_intensity = ?,
        about_us_text = ?,
        business_phone = ?,
        business_address = ?,
        social_instagram = ?,
        social_facebook = ?,
        social_tiktok = ?,
        social_website = ?,
        social_whatsapp = ?,
        client_name = ?,
        phone = ?,
        notes = ?,
        app_description_short = ?,
        app_description_long = ?,
        keywords = ?,
        status = COALESCE(?, status),
        updated_at = NOW()
      WHERE tenant_id = ?`,
      [
        nullOrStr(business_name),
        nullOrStr(business_type) || 'general',
        nullOrStr(brand_preset) || 'classic_modern',
        nullOrStr(logo_url),
        nullOrStr(bg_image_url),
        blurVal,
        nullOrStr(about_us_text),
        nullOrStr(business_phone),
        nullOrStr(business_address),
        nullOrStr(social_instagram),
        nullOrStr(social_facebook),
        nullOrStr(social_tiktok),
        nullOrStr(social_website),
        nullOrStr(social_whatsapp),
        nullOrStr(client_name),
        nullOrStr(phone),
        nullOrStr(notes),
        nullOrStr(app_description_short),
        nullOrStr(app_description_long),
        nullOrStr(keywords),
        statusVal,
        tenantId,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ status: 'error', message: 'Business not found' });
    }

    console.log(`[client update] updated tenant=${tenantId} rows=${result.affectedRows}`);
    res.json({ status: 'success', message: 'Business updated successfully' });
  } catch (e) {
    console.error('[client update]', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── JSON API for SPA ────────────────────────────────────────────────────────

// PREVIEW_URL: set in .env to switch between local dev and production
const PREVIEW_URL = (process.env.PREVIEW_URL || 'http://localhost:8081').replace(/\/$/, '');

app.get('/api/config', (_req, res) => {
  res.json({ previewUrl: '/app/' });
});

app.get('/api/clients', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM businesses ORDER BY created_at DESC');
    res.json({ status: 'success', data: rows });
  } catch (e) {
    console.error('[api/clients]', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/clients', async (req, res) => {
  const body = req.body || {};
  const tenantId = String(body.tenant_id ?? '').trim() ||
    ('biz_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));

  const ns = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  const VALID_STATUSES = ['draft', 'in_progress', 'live'];
  const status = VALID_STATUSES.includes(body.status) ? body.status : 'draft';
  const blurInt = parseInt(body.bg_blur_intensity ?? 22, 10);
  const blurVal = Number.isFinite(blurInt) ? Math.min(100, Math.max(0, blurInt)) : 22;

  try {
    await pool.query(
      `INSERT INTO businesses
        (tenant_id, business_name, business_type, client_name, phone, notes,
         app_description_short, app_description_long, keywords, status,
         brand_preset, logo_url, bg_image_url, bg_blur_intensity,
         about_us_text, business_address,
         social_instagram, social_facebook, social_tiktok, social_website, social_whatsapp,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        tenantId, ns(body.business_name), ns(body.business_type) || 'general',
        ns(body.client_name), ns(body.phone), ns(body.notes),
        ns(body.app_description_short), ns(body.app_description_long), ns(body.keywords),
        status, ns(body.brand_preset) || 'classic_modern',
        ns(body.logo_url), ns(body.bg_image_url), blurVal,
        ns(body.about_us_text), ns(body.business_address),
        ns(body.social_instagram), ns(body.social_facebook), ns(body.social_tiktok),
        ns(body.social_website), ns(body.social_whatsapp),
      ]
    );

    // Auto-provision the business owner's admin account so they can log in via OTP.
    // Strip formatting from the phone number (keep digits only, same as the PHP layer).
    const rawPhone = ns(body.phone);
    if (rawPhone) {
      const digits = rawPhone.replace(/\D/g, '');
      if (digits.length >= 9) {
        const nameParts = (ns(body.client_name) || ns(body.business_name) || tenantId).split(/\s+/);
        const firstName = nameParts[0] || tenantId;
        const lastName  = nameParts.slice(1).join(' ') || '';

        // Upsert: if this phone already exists, promote to admin and bind to the new tenant.
        await pool.query(
          `INSERT INTO users (phone, password_hash, first_name, last_name, role, tenant_id)
           VALUES (?, NULL, ?, ?, 'admin', ?)
           ON DUPLICATE KEY UPDATE
             role      = 'admin',
             tenant_id = VALUES(tenant_id)`,
          [digits, firstName, lastName, tenantId]
        );
        console.log(`[POST /api/clients] admin user provisioned phone=${digits} tenant=${tenantId}`);
      }
    }

    res.status(201).json({ status: 'success', tenant_id: tenantId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ status: 'error', message: 'Tenant ID כבר קיים' });
    console.error('[POST /api/clients]', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Upload in-app logo for a tenant, persist it publicly, and update logo_url in the DB
app.post('/api/clients/:id/logo', uploadLogo, async (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });

  const file = req.file;
  if (!file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });
  if (!isImageMime(file.mimetype)) {
    return res.status(400).json({ status: 'error', message: 'File must be an image (PNG or JPG)' });
  }

  const ext = extForImage(file);
  fs.mkdirSync(CLIENT_LOGOS_DIR, { recursive: true });
  const filename = `${tenantId}${ext}`;
  fs.writeFileSync(path.join(CLIENT_LOGOS_DIR, filename), file.buffer);

  // Use the Node.js API route as the canonical logo URL.
  // This path (/api/clients/:id/logo) is guaranteed to be proxied to Node.js
  // by nginx, unlike /client-logos/* which depends on nginx's static-file rules.
  const publicUrl = `${SERVER_BASE_URL}/api/clients/${tenantId}/logo`;

  try {
    await pool.query(
      'UPDATE businesses SET logo_url = ?, updated_at = NOW() WHERE tenant_id = ?',
      [publicUrl, tenantId]
    );
  } catch (e) {
    console.error('[logo upload] db update failed:', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  console.log(`[logo upload] tenant=${tenantId} url=${publicUrl}`);
  void syncImageUrlsToPhp(tenantId, { logoUri: publicUrl });
  res.json({ status: 'success', url: publicUrl });
});

// Serve stored in-app logo for a tenant (dashboard thumbnail — tries all extensions)
app.get('/api/clients/:id/logo', (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).end();
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  for (const ext of exts) {
    const logoPath = path.join(CLIENT_LOGOS_DIR, `${tenantId}${ext}`);
    if (fs.existsSync(logoPath)) {
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(logoPath);
    }
  }
  return res.status(404).end();
});

// Remove in-app logo for a tenant: delete file on disk and clear logo_url in DB
app.delete('/api/clients/:id/logo', async (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });

  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  for (const ext of exts) {
    const fpath = path.join(CLIENT_LOGOS_DIR, `${tenantId}${ext}`);
    try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch (e) { console.error('[logo delete]', e); }
  }

  try {
    await pool.query('UPDATE businesses SET logo_url = NULL, updated_at = NOW() WHERE tenant_id = ?', [tenantId]);
  } catch (e) {
    console.error('[logo delete] db:', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  console.log(`[logo delete] tenant=${tenantId}`);
  void syncImageUrlsToPhp(tenantId, { logoUri: null });
  res.json({ status: 'success' });
});

// ─── Background image endpoints ───────────────────────────────────────────────

app.post('/api/clients/:id/background', uploadBg, async (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });

  const file = req.file;
  if (!file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });
  if (!isImageMime(file.mimetype)) {
    return res.status(400).json({ status: 'error', message: 'File must be an image (PNG or JPG)' });
  }

  const ext = extForImage(file);
  fs.mkdirSync(CLIENT_BACKGROUNDS_DIR, { recursive: true });
  const filename = `${tenantId}${ext}`;
  fs.writeFileSync(path.join(CLIENT_BACKGROUNDS_DIR, filename), file.buffer);

  const publicUrl = `${SERVER_BASE_URL}/api/clients/${tenantId}/background`;

  try {
    await pool.query(
      'UPDATE businesses SET bg_image_url = ?, updated_at = NOW() WHERE tenant_id = ?',
      [publicUrl, tenantId]
    );
  } catch (e) {
    console.error('[bg upload] db update failed:', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  console.log(`[bg upload] tenant=${tenantId} url=${publicUrl}`);
  void syncImageUrlsToPhp(tenantId, { bgImageUri: publicUrl });
  res.json({ status: 'success', url: publicUrl });
});

app.get('/api/clients/:id/background', (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).end();
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  for (const ext of exts) {
    const bgPath = path.join(CLIENT_BACKGROUNDS_DIR, `${tenantId}${ext}`);
    if (fs.existsSync(bgPath)) {
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(bgPath);
    }
  }
  return res.status(404).end();
});

app.delete('/api/clients/:id/background', async (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });

  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  for (const ext of exts) {
    const fpath = path.join(CLIENT_BACKGROUNDS_DIR, `${tenantId}${ext}`);
    try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch (e) { console.error('[bg delete]', e); }
  }

  try {
    await pool.query('UPDATE businesses SET bg_image_url = NULL, updated_at = NOW() WHERE tenant_id = ?', [tenantId]);
  } catch (e) {
    console.error('[bg delete] db:', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  console.log(`[bg delete] tenant=${tenantId}`);
  void syncImageUrlsToPhp(tenantId, { bgImageUri: null });
  res.json({ status: 'success' });
});

// ─── Gallery image endpoints ───────────────────────────────────────────────────

function getGalleryUrls(tenantId) {
  const dir = path.join(CLIENT_GALLERIES_DIR, tenantId);
  if (!fs.existsSync(dir)) return [];
  const imageExts = /\.(jpe?g|png|gif|webp|bmp)$/i;
  return fs.readdirSync(dir)
    .filter((f) => imageExts.test(f))
    .sort()
    .map((f) => `${SERVER_BASE_URL}/api/clients/${encodeURIComponent(tenantId)}/gallery/${encodeURIComponent(f)}`);
}

app.post('/api/clients/:id/gallery', uploadGalleryItem, async (req, res) => {
  const tenantId = String(req.params.id).trim();

  console.log('[gallery upload] ═══════════════════════════════════════');
  console.log('[gallery upload] STEP 1 — route hit');
  console.log('[gallery upload] req.params :', JSON.stringify(req.params));
  console.log('[gallery upload] content-type:', req.headers['content-type'] ?? '(missing)');
  console.log('[gallery upload] cookie     :', req.headers.cookie ?? '(none — auth cookie absent)');
  console.log('[gallery upload] origin     :', req.headers.origin ?? '(none)');
  console.log('[gallery upload] referer    :', req.headers.referer ?? '(none)');

  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });

  const file = req.file;
  if (file) {
    console.log('[gallery upload] STEP 2 — multer file OK');
    console.log('  fieldname :', file.fieldname);
    console.log('  originalname:', file.originalname);
    console.log('  mimetype  :', file.mimetype);
    console.log('  size      :', file.size, 'bytes');
    console.log('  buffer OK :', Buffer.isBuffer(file.buffer), '— length:', file.buffer?.length ?? 'N/A');
  } else {
    console.error('[gallery upload] STEP 2 FAIL — req.file is undefined (multer found no "gallery_image" field)');
    console.log('[gallery upload] req.files :', JSON.stringify(req.files ?? null));
    console.log('[gallery upload] req.body  :', JSON.stringify(req.body ?? null));
    return res.status(400).json({ status: 'error', message: 'No file uploaded — multer found no field named "gallery_image"' });
  }

  if (!isImageMime(file.mimetype)) {
    console.error('[gallery upload] STEP 2 FAIL — not an image mimetype:', file.mimetype);
    return res.status(400).json({ status: 'error', message: `File must be an image (got ${file.mimetype})` });
  }

  const ext = extForImage(file);
  const dir = path.join(CLIENT_GALLERIES_DIR, tenantId);
  console.log('[gallery upload] STEP 3 — target dir:', dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[gallery upload] STEP 3 — dir ready');
  } catch (e) {
    console.error('[gallery upload] STEP 3 FAIL — mkdirSync:', e.message);
    return res.status(500).json({ status: 'error', message: `Cannot create gallery dir: ${e.message}` });
  }

  const filename = `${Date.now()}${ext}`;
  const filePath = path.join(dir, filename);
  try {
    fs.writeFileSync(filePath, file.buffer);
    console.log('[gallery upload] STEP 3 OK — wrote:', filePath, '(', file.buffer.length, 'bytes)');
  } catch (e) {
    console.error('[gallery upload] STEP 3 FAIL — writeFileSync:', e.message);
    return res.status(500).json({ status: 'error', message: `Cannot write file: ${e.message}` });
  }

  const urls = getGalleryUrls(tenantId);
  console.log('[gallery upload] STEP 4 — gallery URLs after write (', urls.length, 'total):', urls);

  const sqlQuery = 'UPDATE businesses SET gallery_uris = ?, updated_at = NOW() WHERE tenant_id = ?';
  const sqlValues = [JSON.stringify(urls), tenantId];
  console.log('[gallery upload] STEP 5 — SQL:', sqlQuery);
  console.log('[gallery upload] STEP 5 — values:', sqlValues[0], '|', sqlValues[1]);
  try {
    const [dbResult] = await pool.query(sqlQuery, sqlValues);
    console.log('[gallery upload] STEP 5 OK — affectedRows:', dbResult.affectedRows, '| changedRows:', dbResult.changedRows);
    if (dbResult.affectedRows === 0) {
      console.warn('[gallery upload] STEP 5 WARN — 0 rows affected: tenant_id "' + tenantId + '" may not exist in businesses table');
    }
  } catch (e) {
    console.error('[gallery upload] STEP 5 FAIL — DB error:', e.message);
    return res.status(500).json({ status: 'error', message: `DB update failed: ${e.message}` });
  }

  const responseUrl = `${SERVER_BASE_URL}/api/clients/${encodeURIComponent(tenantId)}/gallery/${encodeURIComponent(filename)}`;
  console.log('[gallery upload] DONE ✓ — responseUrl:', responseUrl);
  console.log('[gallery upload] ═══════════════════════════════════════');
  res.json({ status: 'success', url: responseUrl, urls });
});

app.get('/api/clients/:id/gallery', (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });
  res.json({ status: 'success', urls: getGalleryUrls(tenantId) });
});

app.get('/api/clients/:id/gallery/:filename', (req, res) => {
  const tenantId = String(req.params.id).trim();
  const filename = path.basename(String(req.params.filename).trim());
  if (!tenantId || !filename) return res.status(400).end();
  const fpath = path.join(CLIENT_GALLERIES_DIR, tenantId, filename);
  if (!fs.existsSync(fpath)) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(fpath);
});

app.delete('/api/clients/:id/gallery/:filename', async (req, res) => {
  const tenantId = String(req.params.id).trim();
  const filename = path.basename(String(req.params.filename).trim());
  if (!tenantId || !filename) return res.status(400).json({ status: 'error', message: 'tenant_id and filename required' });

  const fpath = path.join(CLIENT_GALLERIES_DIR, tenantId, filename);
  try {
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
  } catch (e) {
    console.error('[gallery delete]', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  const urls = getGalleryUrls(tenantId);

  // Write directly to the shared MySQL DB — same authoritative write as the upload route.
  try {
    await pool.query(
      'UPDATE businesses SET gallery_uris = ?, updated_at = NOW() WHERE tenant_id = ?',
      [urls.length > 0 ? JSON.stringify(urls) : null, tenantId]
    );
  } catch (e) {
    console.error('[gallery delete] db update failed:', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  console.log(`[gallery delete] tenant=${tenantId} file=${filename} remaining=${urls.length}`);
  res.json({ status: 'success', urls });
});

// ─── Icon endpoints ────────────────────────────────────────────────────────────

// Persist an app icon for a tenant immediately (so preview survives page refresh)
app.post('/api/clients/:id/icon', uploadIcon, (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });

  const file = req.file;
  if (!file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });
  if (file.mimetype !== 'image/png') {
    return res.status(400).json({ status: 'error', message: 'Icon must be a PNG image' });
  }

  fs.mkdirSync(CLIENT_ICONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ICONS_DIR, `${tenantId}.png`), file.buffer);

  console.log(`[icon upload] tenant=${tenantId}`);
  res.json({ status: 'success' });
});

// Remove stored app icon for a tenant (only affects future builds; does not touch the DB)
app.delete('/api/clients/:id/icon', (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id required' });

  const iconPath = path.join(CLIENT_ICONS_DIR, `${tenantId}.png`);
  try {
    if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
  } catch (e) {
    console.error('[icon delete]', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }

  console.log(`[icon delete] tenant=${tenantId}`);
  res.json({ status: 'success' });
});

// Serve stored app icon for a tenant (used by the dashboard icon preview)
app.get('/api/clients/:id/icon', (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).end();
  const iconPath = path.join(CLIENT_ICONS_DIR, `${tenantId}.png`);
  if (!fs.existsSync(iconPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(iconPath);
});

app.put('/api/clients/:id', async (req, res) => {
  const tenantId = String(req.params.id).trim();
  if (!tenantId) return res.status(400).json({ status: 'error', message: 'tenant_id is required' });

  const body = req.body || {};
  const ns = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  const VALID_STATUSES = ['draft', 'in_progress', 'live'];
  const blurInt = parseInt(body.bg_blur_intensity ?? '', 10);
  const blurVal = Number.isFinite(blurInt) ? Math.min(100, Math.max(0, blurInt)) : 22;

  // Fields that always have form inputs — always overwrite.
  // Fields without visible inputs (about_us_text, social, etc.) use COALESCE so a missing
  // or null payload value never silently wipes the existing DB value.
  const setClauses = [
    'business_name=?', 'business_type=?', 'client_name=?', 'phone=?', 'notes=?',
    'app_description_short=?', 'app_description_long=?', 'keywords=?',
    'brand_preset=?', 'logo_url=?', 'bg_image_url=?', 'bg_blur_intensity=?',
    'about_us_text    = COALESCE(NULLIF(?,\'\'), about_us_text)',
    'business_address = COALESCE(NULLIF(?,\'\'), business_address)',
    'social_instagram = COALESCE(NULLIF(?,\'\'), social_instagram)',
    'social_facebook  = COALESCE(NULLIF(?,\'\'), social_facebook)',
    'social_tiktok    = COALESCE(NULLIF(?,\'\'), social_tiktok)',
    'social_website   = COALESCE(NULLIF(?,\'\'), social_website)',
    'social_whatsapp  = COALESCE(NULLIF(?,\'\'), social_whatsapp)',
    'updated_at=NOW()',
  ];
  const values = [
    ns(body.business_name), ns(body.business_type) || 'general',
    ns(body.client_name), ns(body.phone), ns(body.notes),
    ns(body.app_description_short), ns(body.app_description_long), ns(body.keywords),
    ns(body.brand_preset) || 'classic_modern',
    ns(body.logo_url), ns(body.bg_image_url), blurVal,
    // For COALESCE fields pass the raw (possibly null) value — NULLIF handles empty strings
    ns(body.about_us_text),  ns(body.business_address),
    ns(body.social_instagram), ns(body.social_facebook), ns(body.social_tiktok),
    ns(body.social_website),   ns(body.social_whatsapp),
  ];

  if (body.status && VALID_STATUSES.includes(body.status)) {
    setClauses.splice(setClauses.length - 1, 0, 'status=?');
    values.push(body.status);
  }
  values.push(tenantId);

  try {
    const [result] = await pool.query(
      `UPDATE businesses SET ${setClauses.join(',')} WHERE tenant_id=?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ status: 'error', message: 'Business not found' });
    console.log(`[PUT /api/clients/${tenantId}] rows=${result.affectedRows}`);
    // Sync image URLs to the PHP-side DB so get_business_config.php sees the latest values
    const phpFields = {};
    if (ns(body.logo_url)     !== undefined) phpFields.logoUri    = ns(body.logo_url);
    if (ns(body.bg_image_url) !== undefined) phpFields.bgImageUri = ns(body.bg_image_url);
    if (Object.keys(phpFields).length > 0) void syncImageUrlsToPhp(tenantId, phpFields);
    res.json({ status: 'success', message: 'Updated successfully' });
  } catch (e) {
    console.error('[PUT /api/clients]', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('/dashboard', (req, res) => res.redirect('/'));
if (false) (async (req, res) => {  // legacy — SPA handles this now
  let rows = [];
  let dbError = null;
  console.log('[dashboard] running query: SELECT * FROM businesses ORDER BY created_at DESC');
  try {
    [rows] = await pool.query('SELECT * FROM businesses ORDER BY created_at DESC');
    console.log(`[dashboard] query OK — ${rows.length} rows returned`);
    console.log('[dashboard] businesses:', JSON.stringify(rows, null, 2));
  } catch (e) {
    console.error('[dashboard] query ERROR:', e.message);
    console.error('[dashboard] full error:', e);
    dbError = e.message;
  }

  const escape = (s) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const businessRows = rows.map((b) => {
    const tid = escape(b.tenant_id);
    const name = escape(b.business_name) || `<em style="color:#64748b">${tid}</em>`;
    return `
    <tr style="cursor:pointer" onclick="window.location='/client/${tid}'">
      <td>
        <a href="/client/${tid}" onclick="event.stopPropagation()" style="color:#818cf8;font-weight:600;text-decoration:none;hover:underline">${name}</a>
      </td>
      <td><code>${tid}</code></td>
      <td>${escape(b.business_type ?? '—')}</td>
      <td>${b.created_at ? new Date(b.created_at).toLocaleString('he-IL') : '—'}</td>
      <td style="white-space:nowrap" onclick="event.stopPropagation()">
        <a href="/client/${tid}" style="display:inline-block;background:#6366f1;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:.8rem;font-weight:600;margin-left:6px">פרטים</a>
        <a href="/update/${tid}" style="display:inline-block;background:#8B5CF6;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:.8rem;font-weight:600;margin-left:6px">עדכן OTA</a>
        <button onclick="confirmDelete('${tid}')" style="background:#EF4444;color:#fff;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:.8rem;font-weight:600">מחק</button>
      </td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Dashboard — עסקים רשומים</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0B0F19;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 2rem 1rem;
    }
    .container { max-width: 960px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 2.5rem; }
    h1 {
      font-size: 2rem;
      font-weight: 800;
      background: linear-gradient(to right, #fff, #94a3b8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: .5rem;
    }
    .subtitle { color: #64748b; font-size: .9rem; }
    .back-link {
      display: inline-block;
      margin-bottom: 1.5rem;
      color: #818cf8;
      text-decoration: none;
      font-size: .9rem;
    }
    .back-link:hover { text-decoration: underline; }
    .error-box {
      background: #450a0a;
      border: 1px solid #7f1d1d;
      color: #fca5a5;
      padding: 1rem 1.25rem;
      border-radius: .75rem;
      margin-bottom: 1.5rem;
      font-size: .9rem;
    }
    .count { color: #64748b; font-size: .85rem; margin-bottom: 1rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #111827;
      border-radius: .75rem;
      overflow: hidden;
      box-shadow: 0 0 0 1px rgba(255,255,255,.07);
    }
    thead { background: #1e293b; }
    th {
      padding: .75rem 1rem;
      text-align: right;
      font-size: .8rem;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    td {
      padding: .85rem 1rem;
      font-size: .9rem;
      border-top: 1px solid rgba(255,255,255,.05);
      color: #cbd5e1;
      vertical-align: middle;
    }
    tr:hover td { background: rgba(99,102,241,.08); }
    tr { transition: background .15s; }
    code {
      background: #1e293b;
      color: #a5b4fc;
      padding: .15rem .4rem;
      border-radius: .35rem;
      font-size: .8rem;
    }
    .empty { text-align: center; padding: 3rem; color: #475569; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Dashboard — עסקים רשומים</h1>
      <p class="subtitle">רשימת כל העסקים במערכת</p>
    </header>
    <a class="back-link" href="/">← חזרה לבניית אפליקציה</a>
    ${dbError ? `<div class="error-box">שגיאת חיבור למסד נתונים: ${escape(dbError)}</div>` : ''}
    <p class="count">${rows.length} עסקים נמצאו</p>
    <table>
      <thead>
        <tr>
          <th>שם עסק</th>
          <th>Tenant ID</th>
          <th>סוג עסק</th>
          <th>נוצר בתאריך</th>
          <th>פעולות</th>
        </tr>
      </thead>
      <tbody>
        ${rows.length ? businessRows : '<tr><td colspan="5" class="empty">אין עסקים רשומים עדיין</td></tr>'}
      </tbody>
    </table>
  </div>
  <script>
    function confirmDelete(tenantId) {
      if (!confirm('האם אתה בטוח שברצונך למחוק את העסק "' + tenantId + '"?\\nפעולה זו אינה ניתנת לביטול.')) return;
      fetch('/api/delete_business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.status === 'success') {
            alert('העסק נמחק בהצלחה');
            location.reload();
          } else {
            alert('שגיאה: ' + (data.message || 'מחיקה נכשלה'));
          }
        })
        .catch(() => alert('שגיאת רשת — נסה שוב'));
    }
  </script>
</body>
</html>`;

  res.type('text/html').send(html);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      status: 'error',
      message: err.message || 'Upload failed',
    });
  }
  next(err);
});

// SPA catch-all: /app/... routes that don't match a static file return the Expo app shell
app.get(/^\/app(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`App Builder server listening on http://localhost:${PORT}`);
  console.log(`Expo project path: ${EXPO_PROJECT_PATH}`);
  console.log(`[gallery] CLIENT_GALLERIES_DIR: ${CLIENT_GALLERIES_DIR}`);
  console.log('[gallery] Routes registered: POST/GET/DELETE /api/clients/:id/gallery and GET /api/clients/:id/gallery/:filename');
  runMigrations().catch((e) => console.error('[migration] failed:', e));
});

// מנגנון תפיסת שגיאות שיגיד לנו בדיוק למה השרת קורס
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`🚨 Error: Port ${PORT} is already in use. Please change PORT in .env`);
  } else {
    console.error('🚨 Server error:', err);
  }
});

process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err);
});
