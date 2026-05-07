require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

// Local Expo app folder — edit here or set EXPO_PROJECT_PATH in .env
const EXPO_PROJECT_PATH =
  process.env.EXPO_PROJECT_PATH || path.join(__dirname, 'expo-app');

const PORT = Number(process.env.PORT) || 3000;

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

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const PHP_API_BASE = (process.env.PHP_API_BASE || '').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

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

  if (!appIconFile) {
    return res.status(400).json({
      status: 'error',
      message: 'אייקון חנויות (appIcon) הוא שדה חובה',
    });
  }

  const assetsDir = path.join(EXPO_PROJECT_PATH, 'assets');

  const removeBgRequested = isTruthyFormFlag(removeBackgroundImage);
  /** הסרת לוגו פנימי בלבד (מסך התחברות) — לא משנה אייקון חנויות */
  const removeLoginLogoRequested = isTruthyFormFlag(removeLogo);

  if (appIconFile) {
    if (appIconFile.mimetype !== 'image/png') {
      return res.status(400).json({
        status: 'error',
        message: 'Icon must be a PNG image',
      });
    }
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'icon.png'), appIconFile.buffer);
    fs.writeFileSync(path.join(assetsDir, 'adaptive-icon.png'), appIconFile.buffer);
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

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      status: 'error',
      message: err.message || 'Upload failed',
    });
  }
  next(err);
});

const server = app.listen(PORT, () => {
  console.log(`App Builder server listening on http://localhost:${PORT}`);
  console.log(`Expo project path: ${EXPO_PROJECT_PATH}`);
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
