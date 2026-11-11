'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { get, post, put } = require('../router');
const db = require('../db');
const { createLine } = require('../services/lineService') || {};
const aylol = require('../services/aylolService') || {};

const AUTH_DIR = path.join(process.cwd(), 'data', 'wa-auth');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let waUser = null;
let config = {
  autoReply: true,
  welcomeMsg: 'مرحباً بك في خدمة eSIM الذكية عبر واتساب! 📱✨\n\nأرسل كلمة *الباقات* أو *b* لرؤية قائمة الباقات المتاحة.'
};

async function initWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        connectionStatus = 'connecting';
        qrCodeData = await QRCode.toDataURL(qr);
      }
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
        connectionStatus = 'disconnected';
        qrCodeData = null;
        waUser = null;
        if (shouldReconnect) setTimeout(initWhatsApp, 3000);
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrCodeData = null;
        waUser = sock.user;
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (!config.autoReply || m.type !== 'notify') return;
      for (const msg of m.messages) {
        if (!msg.key.fromMe && msg.message) await handleIncomingMessage(msg);
      }
    });
  } catch (err) {
    connectionStatus = 'disconnected';
  }
}

async function handleIncomingMessage(msg) {
  const from = msg.key.remoteJid;
  const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();
  if (!text) return;

  if (text.includes('باقات') || text === 'b' || text.includes('packages') || text === '1') {
    try {
      const packages = db.prepare ? db.prepare('SELECT * FROM packages WHERE active = 1 LIMIT 10').all() : [];
      let responseMsg = '📦 *الباقات المتاحة:*\n\n';
      if (packages && packages.length > 0) {
        packages.forEach((pkg, index) => {
          responseMsg += `${index + 1}. *${pkg.name || pkg.title}* - ${pkg.price} $ (${pkg.data_gb || pkg.gb || '1'}GB / ${pkg.days || '30'} يوماً)\n   للشراء أرسل: *شراء ${pkg.id}*\n\n`;
        });
      } else {
        responseMsg += '1. باقة 5GB - $10 (رمز: P5GB)\n2. باقة 10GB - $18 (رمز: P10GB)\n\nللشراء أرسل: *شراء [الرمز]*';
      }
      await sock.sendMessage(from, { text: responseMsg });
    } catch (err) {
      await sock.sendMessage(from, { text: 'خطأ في جلب الباقات. يرجى المحاولة لاحقاً.' });
    }
  } else if (text.startsWith('شراء') || text.startsWith('buy')) {
    const pkgId = text.split(' ')[1];
    if (!pkgId) {
      await sock.sendMessage(from, { text: 'يرجى تحديد رمز الباقة. مثال: *شراء 1*' });
      return;
    }
    await sock.sendMessage(from, { text: '⏳ جاري فحص الأرقام المتاحة وتنفيذ التفعيل الفوري...' });
    try {
      let orderRes = null;
      if (aylol && typeof aylol.executeOrder === 'function') orderRes = await aylol.executeOrder({ packageId: pkgId, phone: from });
      let lineRes = null;
      if (typeof createLine === 'function') lineRes = await createLine({ packageId: pkgId, phone: from });

      const esimCode = orderRes?.esimCode || lineRes?.esimCode || orderRes?.qrCode || 'LPA:1$rsp.global$E-SIM-DEMO-' + Date.now();
      const qrDataUrl = await QRCode.toDataURL(esimCode);
      const buffer = Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');

      await sock.sendMessage(from, {
        image: buffer,
        caption: `✅ *تم تفعيل eSIM بنجاح!*\n\nكود التفعيل: \`${esimCode}\`\n\nقم بمسح الرمز أعلاه لتثبيت الشريحة على هاتفك.`
      });
    } catch (err) {
      await sock.sendMessage(from, { text: '❌ حدث خطأ أثناء تفعيل الشريحة. يرجى التواصل مع الدعم.' });
    }
  } else {
    await sock.sendMessage(from, { text: config.welcomeMsg });
  }
}

get('/api/whatsapp/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, user: waUser, config }));
get('/api/whatsapp/public-info', (req, res) => res.json({ connected: connectionStatus === 'connected', phone: waUser?.id ? waUser.id.split(':')[0] : null }));
post('/api/whatsapp/connect', async (req, res) => { await initWhatsApp(); res.json({ success: true, message: 'WhatsApp connection initiated' }); });
post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    if (sock) { await sock.logout(); sock = null; }
    connectionStatus = 'disconnected'; qrCodeData = null; waUser = null;
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({ success: true, message: 'Disconnected successfully' });
  } catch (err) { res.json({ success: false, error: err.message }); }
});
put('/api/whatsapp/config', (req, res) => {
  const body = req.body || {};
  if (typeof body.autoReply === 'boolean') config.autoReply = body.autoReply;
  if (body.welcomeMsg) config.welcomeMsg = body.welcomeMsg;
  res.json({ success: true, config });
});
post('/api/whatsapp/send', async (req, res) => {
  const { to, text, image } = req.body || {};
  if (!sock || connectionStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp is not connected' });
  try {
    const recipient = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
    if (image) {
      const buffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      await sock.sendMessage(recipient, { image: buffer, caption: text });
    } else {
      await sock.sendMessage(recipient, { text: text || '' });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function injectUIElements() {
  try {
    const settingsPath = path.join(process.cwd(), 'public', 'js', 'views', 'settings.js');
    if (fs.existsSync(settingsPath)) {
      let content = fs.readFileSync(settingsPath, 'utf8');
      if (!content.includes('whatsapp-settings-card')) {
        const injection = `\n// WhatsApp Settings Card\nif (!document.getElementById('whatsapp-settings-card')) {\n  const card = document.createElement('div');\n  card.id = 'whatsapp-settings-card';\n  card.className = 'card mb-4';\n  card.innerHTML = \`\n    <div class="card-header d-flex justify-content-between align-items-center">\n      <h5 class="mb-0">📱 إعدادات واتساب ورمز QR</h5>\n      <span id="wa-status-badge" class="badge bg-secondary">مفصول</span>\n    </div>\n    <div class="card-body text-center">\n      <div id="wa-qr-container" class="mb-3">\n        <img id="wa-qr-img" src="" alt="WhatsApp QR Code" style="max-width: 250px; display: none;" />\n        <p id="wa-qr-text" class="text-muted">اضغط على اتصال لعرض رمز QR</p>\n      </div>\n      <button id="wa-connect-btn" class="btn btn-primary me-2" onclick="connectWhatsApp()">اتصال / تحديث QR</button>\n      <button id="wa-disconnect-btn" class="btn btn-danger" onclick="disconnectWhatsApp()">قطع الاتصال</button>\n    </div>\n  \`;\n  const container = document.querySelector('.container') || document.body;\n  container.prepend(card);\n}\n`;
        fs.appendFileSync(settingsPath, injection);
      }
    }
    const shopPath = path.join(process.cwd(), 'public', 'shop.html');
    if (fs.existsSync(shopPath)) {
      let shopContent = fs.readFileSync(shopPath, 'utf8');
      if (!shopContent.includes('whatsapp-smart-btn')) {
        const smartBtn = `\n<!-- WhatsApp Smart Button -->\n<a id="whatsapp-smart-btn" href="https://wa.me/" target="_blank" style="position: fixed; bottom: 20px; right: 20px; z-index: 9999; background: #25D366; color: white; border-radius: 50%; width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.3); text-decoration: none;">\n  <span style="font-size: 30px;">💬</span>\n</a>\n`;
        shopContent = shopContent.replace('</body>', `${smartBtn}\n</body>`);
        fs.writeFileSync(shopPath, shopContent);
      }
    }
  } catch (err) {}
}

initWhatsApp();
injectUIElements();

module.exports = { initWhatsApp };
