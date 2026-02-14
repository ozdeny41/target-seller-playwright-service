const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

// KRITIK: Unhandled rejection/exception - process crash onle (Railway restart dongusu)
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [Target Seller Playwright] Unhandled Rejection:', reason);
  if (reason && reason.stack) console.error(reason.stack);
});
process.on('uncaughtException', (err) => {
  console.error('❌ [Target Seller Playwright] Uncaught Exception:', err.message);
  if (err.stack) console.error(err.stack);
});

// Browser yukleme
let browserInstallationInProgress = false;
let browserInstallationComplete = false;
let browserInstallationPromise = null;

function findChromiumExecutable() {
  const fs = require('fs');
  const path = require('path');
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.cache', 'ms-playwright'),
    path.join(process.cwd(), 'node_modules', '.cache', 'ms-playwright')
  ].filter(Boolean);
  const candidates = [
    ['chrome-linux', 'chrome'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chromium-1200', 'chrome-headless-shell-linux64', 'chrome-headless-shell']
  ];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const dirs = fs.readdirSync(root);
      const chromiumDir = dirs.find(d => d.startsWith('chromium') || d.startsWith('chrome'));
      if (!chromiumDir) continue;
      const base = path.join(root, chromiumDir);
      for (const parts of candidates) {
        const exe = path.join(base, ...parts);
        if (fs.existsSync(exe)) return exe;
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

const runBrowserCheck = () => {
  browserInstallationPromise = (async () => {
    try {
      console.log('🔧 [Target Seller Playwright] Tarayici kontrolu baslatiliyor...');
      const fs = require('fs');
      const path = require('path');
      const execSync = require('child_process').execSync;
      const exe = findChromiumExecutable();
      if (exe) {
        console.log(`✅ [Target Seller Playwright] Chromium bulundu`);
        browserInstallationComplete = true;
        return;
      }
      console.log('⚠️ [Target Seller Playwright] Chromium bulunamadi, yukleniyor...');
      browserInstallationInProgress = true;
      try {
        execSync('npx playwright install chromium --with-deps', { stdio: 'inherit', timeout: 300000 });
        browserInstallationComplete = true;
      } catch (e) {
        try {
          execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 180000 });
          browserInstallationComplete = true;
        } catch (e2) { /* ignore */ }
      } finally {
        browserInstallationInProgress = false;
      }
    } catch (e) {
      console.error('❌ [Target Seller Playwright] Tarayici kontrolu hatasi:', e.message);
      browserInstallationInProgress = false;
    }
  })();
};

runBrowserCheck();
global.__browserInstallationPromise = browserInstallationPromise || Promise.resolve();
global.__browserInstallationComplete = browserInstallationComplete;
global.__browserInstallationInProgress = browserInstallationInProgress;
browserInstallationPromise && browserInstallationPromise.then(() => {
  global.__browserInstallationComplete = true;
  global.__browserInstallationInProgress = false;
}).catch(() => { global.__browserInstallationInProgress = false; });

const app = express();
const PORT = process.env.PORT || 3003;

// CORS ayarlari
const corsOptions = {
  origin: '*',
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
};

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

app.use(cors(corsOptions));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'target-seller-playwright-service',
    timestamp: new Date().toISOString()
  });
});

// Target Seller DB health check
app.get('/seller-db-health', async (req, res) => {
  try {
    const sellerDbService = require('./services/sellerDbService');
    const dbUrl = process.env.SELLER_DATABASE_URL;
    const isInternal = dbUrl && dbUrl.includes('.railway.internal');
    let directError = null;
    try {
      const { Pool } = require('pg');
      const testPool = new Pool({ connectionString: dbUrl, ssl: isInternal ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
      const r = await testPool.query('SELECT 1 as ok');
      await testPool.end();
    } catch (e) {
      directError = e.message;
    }
    if (directError) {
      return res.json({ ok: false, error: directError, dbUrl: dbUrl ? dbUrl.replace(/\/\/[^@]+@/, '//***@') : 'NOT SET', isInternal });
    }
    // Test write
    await sellerDbService.saveSellers('TEST-HEALTH', 'test', null, [{ sellerName: 'HealthTest', price: 1, condition: 'New' }]);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.SELLER_DATABASE_URL, ssl: process.env.SELLER_DATABASE_URL.includes('.railway.internal') ? false : { rejectUnauthorized: false } });
    const result = await pool.query('SELECT count(*) as cnt FROM "TargetSeller" WHERE asin = $1', ['TEST-HEALTH']);
    const count = parseInt(result.rows[0].cnt);
    await pool.query('DELETE FROM "TargetSeller" WHERE asin = $1', ['TEST-HEALTH']);
    await pool.end();
    return res.json({ ok: count > 0, count, message: count > 0 ? 'DB yazma testi basarili' : 'Yazma basarisiz' });
  } catch (e) {
    return res.json({ ok: false, error: e.message, stack: e.stack?.substring(0, 300) });
  }
});

// Routes
app.use('/api', require('./routes'));

// Error handling
app.use((err, req, res, next) => {
  console.error('❌ [Target Seller Playwright] Error:', err);
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'Internal server error'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [Target Seller Playwright] Server running on port ${PORT}`);
  console.log(`📡 [Target Seller Playwright] Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`🎯 [Target Seller Playwright] Bu servis HEDEF PAZAR (navbar secili ulke) satici bilgilerini ceker`);
  console.log(`🔗 [Target Seller Playwright] SELLER_DATABASE_URL: ${process.env.SELLER_DATABASE_URL ? '✅ TANIMLI' : '❌ TANIMLI DEGIL'}`);
  
  setImmediate(async () => {
    try {
      const sellerDbService = require('./services/sellerDbService');
      await sellerDbService.testConnection();
    } catch (e) {
      console.warn('⚠️ [Target Seller Playwright] DB baglanti testi hatasi:', e.message);
    }
    
    try {
      const playwrightService = require('./services/playwrightService');
      if (playwrightService && typeof playwrightService.getBrowser === 'function') {
        console.log(`🔥 [Target Seller Playwright] Tarayici warmup baslatildi...`);
        playwrightService.getBrowser().then(() => console.log(`✅ [Target Seller Playwright] Tarayici warmup tamamlandi`)).catch(e => console.warn('⚠️ [Target Seller Playwright] Warmup hatasi:', e.message));
      }
    } catch (e) { /* ignore */ }
  });
});
