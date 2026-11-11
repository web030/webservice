const fs = require('fs');
const path = require('path');

console.log('Installing Aylol integration inside agents-app...');

const aylolJsPath = path.join(__dirname, 'src/aylol.js');
const aylolJsContent = `const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class AylolError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'AylolError';
    this.details = details;
  }
}

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CK = path.join(DATA_DIR, 'aylol.cookies.txt');
const CHARGE_CACHE = path.join(DATA_DIR, 'aylol-charge.html');
const BASE = 'https://' + 'aylol.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

let state = {
  seed: '',
  csrf: '',
  user: '',
  loggedAt: 0,
  chargeHtml: '',
  balance: ''
};

function resolveCreds(creds = {}) {
  let u = (creds.user || '').trim();
  let p = (creds.pass || '').trim();
  if (!u || !p) {
    try {
      const db = require('./db');
      const c = db.aylolCredentials ? db.aylolCredentials() : null;
      if (c) {
        u = u || (c.user || '').trim();
        p = p || (c.pass || '').trim();
      }
    } catch (e) {}
  }
  return { user: u || 'binyamin1999o@gmail.com', pass: p || 'Hotesim12' };
}

function curlToFile(out, args) {
  execFileSync('curl', ['--http2', '-L', '-sS', '--max-time', '35', '-A', UA, ...args, '-o', out], { stdio: 'ignore' });
  return fs.readFileSync(out, 'utf8');
}

function navCurl(out, url, ref, extra = []) {
  return curlToFile(out, [
    '-b', CK, '-c', CK,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: ar,en;q=0.9',
    ...(ref ? ['-H', 'Referer: ' + ref] : []),
    '-H', 'Sec-Fetch-Dest: document',
    '-H', 'Sec-Fetch-Mode: navigate',
    '-H', 'Sec-Fetch-Site: ' + (ref ? 'same-origin' : 'none'),
    ...extra,
    url
  ]);
}

function exCsrf(h) {
  return (h && (
    h.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    h.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i)?.[1]
  )) || '';
}

function exSeed(h) {
  if (!h) return '';
  return h.match(/seed::v1\\*\\["']([^"']+)["']/i)?.[1] ||
         h.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
         h.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i)?.[1] ||
         h.match(/<input[^>]*name=["']seed["'][^>]*value=["']([^"']+)["']/i)?.[1] ||
         h.match(/(?:device|seed|token)["']?\\s*[:=]\\s*["']([a-zA-Z0-9_\\-]{16,128})["']/i)?.[1] || '';
}

function exBalance(h) {
  if (!h) return '';
  const m = h.match(/R\\.?[SS]\\s*[\\d\\.\\,]+/i) || h.match(/[\\d\\.\\,]+\\s*ر\\.?س/i) || h.match(/الرصيد\\s*[:\\=]?\\s*([\\d\\.\\,]+)/i);
  return m ? m[0].trim() : '';
}

async function login(creds) {
  const c = resolveCreds(creds);
  if (!c.user || !c.pass) throw new AylolError('اسم المستخدم وكلمة المرور مطلوبان');
  if (fs.existsSync(CK)) {
    try {
      const h = navCurl(CHARGE_CACHE, BASE + '/dashboard/charge-system', BASE + '/admin/home');
      const s = exSeed(h), cs = exCsrf(h);
      if (s && cs) {
        Object.assign(state, { seed: s, csrf: cs, user: c.user, loggedAt: Date.now(), chargeHtml: h, balance: exBalance(h) });
        return { ok: true, user: c.user, seed: s.slice(0, 12) + '...', balance: state.balance };
      }
    } catch (e) {}
    try { if (fs.existsSync(CK)) fs.unlinkSync(CK); } catch (e) {}
  }
  const loginHtml = curlToFile(path.join(DATA_DIR, 'login.html'), ['-c', CK, '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', '-H', 'Accept-Language: ar,en;q=0.9', '-H', 'Sec-Fetch-Dest: document', '-H', 'Sec-Fetch-Mode: navigate', '-H', 'Sec-Fetch-Site: none', '-H', 'Sec-Fetch-User: ?1', '-H', 'Upgrade-Insecure-Requests: 1', BASE + '/login']);
  const csrf1 = exCsrf(loginHtml);
  if (!csrf1) throw new AylolError('تعذر استخراج رمز CSRF لصفحة تسجيل الدخول');
  navCurl(path.join(DATA_DIR, 'after-login.html'), BASE + '/login', BASE + '/login', ['-H', 'Origin: ' + BASE, '-H', 'Content-Type: application/x-www-form-urlencoded', '--data-urlencode', 'email=' + c.user, '--data-urlencode', 'password=' + c.pass, '--data-urlencode', '_token=' + csrf1]);
  const ch = navCurl(CHARGE_CACHE, BASE + '/dashboard/charge-system', BASE + '/admin/home');
  const seed = exSeed(ch), csrf2 = exCsrf(ch) || csrf1;
  if (!seed) throw new AylolError('تعذر استخراج رمز الجهاز بعد تسجيل الدخول');
  Object.assign(state, { seed, csrf: csrf2, user: c.user, loggedAt: Date.now(), chargeHtml: ch, balance: exBalance(ch) });
  return { ok: true, user: c.user, seed: seed.slice(0, 12) + '...', balance: state.balance };
}

async function getPackages(creds) {
  await login(creds);
  const h = fs.existsSync(CHARGE_CACHE) ? fs.readFileSync(CHARGE_CACHE, 'utf8') : navCurl(CHARGE_CACHE, BASE + '/dashboard/charge-system', BASE + '/admin/home');
  state.balance = exBalance(h);
  return { ok: true, balance: state.balance, user: state.user };
}

module.exports = { login, getPackages, AylolError };
`;

fs.writeFileSync(aylolJsPath, aylolJsContent);
console.log('Created src/aylol.js');

const routesDir = path.join(__dirname, 'src/routes');
if (!fs.existsSync(routesDir)) fs.mkdirSync(routesDir, { recursive: true });

const aylolRoutePath = path.join(routesDir, 'aylol.js');
const aylolRouteContent = `const express = require('express');
const router = express.Router();
const aylol = require('../aylol');
const db = require('../db');

router.get('/status', async (req, res) => {
  try {
    const creds = db.aylolCredentials ? db.aylolCredentials() : {};
    const resu = await aylol.login(creds);
    res.json(resu);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/packages', async (req, res) => {
  try {
    const creds = db.aylolCredentials ? db.aylolCredentials() : {};
    const resu = await aylol.getPackages(creds);
    res.json(resu);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
`;
fs.writeFileSync(aylolRoutePath, aylolRouteContent);
console.log('Created src/routes/aylol.js');

const dbPath = path.join(__dirname, 'src/db.js');
if (fs.existsSync(dbPath)) {
  let dbContent = fs.readFileSync(dbPath, 'utf8');
  if (!dbContent.includes('aylolCredentials')) {
    dbContent += `\n\nfunction aylolCredentials() {\n  return {\n    user: process.env.AYLOL_USER || 'binyamin1999o@gmail.com',\n    pass: process.env.AYLOL_PASS || 'Hotesim12'\n  };\n}\nmodule.exports.aylolCredentials = aylolCredentials;\n`;
    fs.writeFileSync(dbPath, dbContent);
    console.log('Patched src/db.js');
  }
}

const serverPath = path.join(__dirname, 'server.js');
if (fs.existsSync(serverPath)) {
  let serverContent = fs.readFileSync(serverPath, 'utf8');
  if (!serverContent.includes('/api/aylol')) {
    serverContent = serverContent.replace("app.use('/api',", "app.use('/api/aylol', require('./src/routes/aylol'));\napp.use('/api',");
    if (!serverContent.includes('/api/aylol')) {
      serverContent += `\napp.use('/api/aylol', require('./src/routes/aylol'));\n`;
    }
    fs.writeFileSync(serverPath, serverContent);
    console.log('Patched server.js');
  }
}

console.log('Aylol installation completed successfully.');
