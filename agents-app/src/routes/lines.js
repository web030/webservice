'use strict';
const { q, tx, getSettings } = require('../db');
const {
  fail, now, round, str, num, optNum, int, isBlank, dateOrNull, normalizePhone, validPhone, periodEnd,
} = require('../util');
const D = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const monthsText = (m) => (m === 1 ? 'شهر' : m === 2 ? 'شهران' : m <= 10 ? `${m} أشهر` : `${m} شهراً`);
const durationText = (months, days) => (days ? `${days} يوماً` : monthsText(months));

const view = (lineId, user) => {
  const l = D.getLine(lineId, user);
  const qr = q('SELECT esim_qr FROM lines WHERE id = ?').get(l.id)?.esim_qr || '';
  return { ...D.lineView(l, user.role), ...(qr ? { esimQr: qr } : {}) };
};

function listLines(user, query) {
  const args = [];
  let where = '1=1';
  if (user.role === 'agent') { where += ' AND l.agent_id = ?'; args.push(user.id); }
  else if (query.agentId) { where += ' AND l.agent_id = ?'; args.push(Number(query.agentId)); }
  if (query.status) { where += ' AND l.status = ?'; args.push(String(query.status)); }
  const warn = getSettings().warnDays;
  return q(`${D.LINE_SELECT} WHERE ${where} ORDER BY l.activated_at DESC, l.id DESC LIMIT 5000`).all(...args)
    .map((l) => D.lineView(l, user.role, warn));
}

route('GET', '/api/lines', ANY, ({ user, query }) => listLines(user, query));

// Live check while typing a number in the wizard.
route('GET', '/api/lines/check', ANY, ({ user, query }) => {
  const number = normalizePhone(query.number);
  if (!/^\d{9,13}$/.test(number)) return { valid: false, number };
  const l = q("SELECT id, agent_id, status FROM lines WHERE number = ? AND status != 'disconnected'").get(number);
  const mine = !!l && (user.role === 'admin' || l.agent_id === user.id);
  return { valid: true, number, exists: !!l, mine, lineId: mine ? l.id : null, pending: mine && l.status === 'pending' };
});

route('GET', '/api/lines/:id', ANY, ({ user, params }) => {
  const l = D.getLine(params.id, user);
  const { esim_qr: esimQr } = q('SELECT esim_qr FROM lines WHERE id = ?').get(l.id);
  // What the supplier did with the line (QuickLine's state changes) is the manager's only.
  const history = q(`SELECT * FROM ops WHERE line_id = ? ${user.role === 'agent' ? "AND type != 'supplier_sync'" : ''}
                     ORDER BY ts DESC, id DESC LIMIT 100`).all(l.id).map(D.opView(user.role));
  return { line: { ...D.lineView(l, user.role), esimQr }, history };
});

// ----- activation -----
route('POST', '/api/lines', ANY, ({ user, body }) => tx(() => createLine(user, body)));

// A new line or card recharge sold by `user` (an agent, or the manager for body.agentId). Runs inside the caller's transaction.
function createLine(user, body) {
  const isAdmin = user.role === 'admin';
  const agent = isAdmin ? D.getAgent(body.agentId) : D.getUser(user.id);
  if (!agent.active) fail(403, 'حساب الوكيل موقوف');
  // kind 'external' = card recharge for a prepaid number activated outside the portal.
  const kind = body.kind === 'external' ? 'external' : 'new';
  let months = int(Number(body.months ?? 1), 'المدة', 1, 24);
  const port = kind === 'new' && !!body.port;
  const esim = kind === 'new' && !!body.esim;
  const number = validPhone(normalizePhone(body.number));
  const existing = q("SELECT id, agent_id FROM lines WHERE number = ? AND status != 'disconnected'").get(number);
  if (existing) {
    // Recharging a card on one of the agent's own numbers extends that line.
    if (kind === 'external' && existing.agent_id === agent.id) return { ...renewLine(user, D.getLine(existing.id, user), body), renewed: true };
    fail(409, kind === 'external' ? `الرقم ${number} مسجّل عند وكيل آخر. تواصل مع المدير.` : `الرقم ${number} مفعّل مسبقاً`);
  }

  const { pkg, offer, unit: quoted } = D.quote(agent.id, { packageId: body.packageId, offerId: body.offerId });
  // QuickLine's two systems cannot stand in for each other: a new-line package opens a line, an extension extends one.
  if (kind === 'external' && /^(qln|lyn|tcn):/.test(pkg.art_card_id || '')) fail(400, 'هذه رزمة تفعيل خط جديد، وليست شحناً لرقم');
  if (kind === 'new' && /^(ql|ly|tc):/.test(pkg.art_card_id || '')) fail(400, 'هذه رزمة تمديد: اختر رزمة تفعيل خط جديد');
  let unit = quoted;
  if (isAdmin && !isBlank(body.unitPrice)) unit = num(body.unitPrice, 'السعر');
  if (unit < 0) fail(400, 'السعر لا يكون سالباً');
  if (!isAdmin && !(unit > 0)) fail(400, 'لم يحدد المدير سعر هذه الرزمة بعد');
  // A package with a set duration (e.g. 90 days) is sold once, not per month.
  const days = pkg.days || null;
  if (days) months = 1;
  // The eSIM activation fee uses the company's custom eSIM QR fee if configured, or the global esimFee setting.
  const companyFee = pkg.company_esim_fee === null || pkg.company_esim_fee === undefined ? null : Number(pkg.company_esim_fee);
  const esimFee = esim ? (companyFee !== null && Number.isFinite(companyFee) ? companyFee : getSettings().esimFee) : 0;
  const total = round(unit * months + esimFee);
  const cost = round(pkg.cost * months + esimFee);

  // A QuickLine new line (the manager's sale too) is activated there automatically, so everything QuickLine checks is
  // checked here first, before the agent pays: the number comes from QuickLine's free numbers (eSIM: with its own
  // eSIM), a ported number names the company it leaves, the SIM fits the company's rule, and the customer has a name.
  const qlRef = kind === 'new' && /^qln:/.test(pkg.art_card_id || '') ? require('../quickline').parseRef(pkg.art_card_id) : null;
  let qlJob = null;
  let sim = { iccid: '', stockId: null };
  if (qlRef) {
    const QL = require('./quickline');
    if (!str(body.customerName, 80)) fail(400, 'اكتب اسم الزبون — مطلوب لتفعيل هذا الخط');
    if (port) {
      const oldCompany = Number(body.qlOldCompany) || 0;
      if (!oldCompany) fail(400, 'اختر الشركة التي يُحوَّل منها الرقم');
      qlJob = { type: 'neyod', oldCompany };
    } else {
      const picked = QL.servedNumber(qlRef.packageId, esim, Number(body.qlNumberId) || 0);
      if (!picked || picked.phone !== number) fail(400, 'اختر رقم الهاتف من قائمة الأرقام المتاحة');
      qlJob = { type: esim ? 'newEsimSubscription' : 'newSubscription', numberId: Number(body.qlNumberId) };
      // An eSIM number brings its own eSIM, and the QR code to install it.
      if (esim) { sim = { iccid: picked.sim.replace(/\D/g, ''), stockId: null }; qlJob.qr = picked.qr; }
    }
  }
  // A Layan new line is one of the dealer's suspended numbers there, which comes with its SIM: the agent picks it from
  // the list shown, and nothing else (no SIM, no porting, no eSIM switch — an eSIM package brings its eSIM).
  // Or, as an eSIM: one of the free numbers Layan offers as a new eSIM, whose eSIM (and QR code) Layan gives when it is
  // activated — the customer shop and agents can both sell these.
  const lyRef = kind === 'new' &&  (/^lyn:/.test(pkg.art_card_id || '') ? require('../layan').parseRef(pkg.art_card_id) : null;
  let lyJob = null;
  if (lyRef && esim) {
    if (port) fail(400, 'هذه الرزمة لا تدعم تحويل الرقم مع eSIM');
    if (!str(body.customerName, 80)) fail(400, 'اكتب اسم الزبون — مطلوب لتفعيل هذا الخط');
    if (!require('./layan').servedEsim(lyRef.packageId, number)) fail(400, 'اختر رقم الهاتف من قائمة الأرقام المتاحة');
    lyJob = { esim: true };
  } else if (lyRef) {
    if (port || esim) fail(400, 'هذه الرزمة لا تدعم تحويل الرقم أو eSIM');
    const picked = require('./layan').servedNumber(lyRef.packageId, number);
    if (!picked) fail(400, 'اختر رقم الهاتف من قائمة الأرقام المتاحة');
    sim = { iccid: picked.sim.replace(/\D/g, ''), stockId: null };
  }
  // A telecom (ALOHA) eSIM on one of its free numbers: carried out there automatically, with the customer's details
  // the site asks for (the customer shop passes its customer's e-mail and phone).
  const tcRef = kind === 'new' && esim && /^tcn:/.test(pkg.art_card_id || '') ? require('../telecom').parseRef(pkg.art_card_id) : null;
  let tcJob = null;
  if (tcRef) {
    if (port) fail(400, 'هذه الرزمة لا تدعم تحويل الرقم مع eSIM');
    if (!str(body.customerName, 80)) fail(400, 'اكتب اسم الزبون — مطلوب لتفعيل هذا الخط');
    if (!require('./telecom').servedEsim(tcRef.packageId, number)) fail(400, 'اختر رقم الهاتف من قائمة الأرقام المتاحة');
    tcJob = { esim: true, email: str(body.customerEmail, 120), phone: str(body.customerPhone, 20) };
  }
  if (kind === 'new' && !esim && !lyRef) {
    if (isBlank(body.sim) && !body.simId) fail(400, 'أدخل رقم الشريحة أو اخترها من المخزون');
    sim = D.takeSim({ iccid: body.sim, simId: body.simId }, { agentId: agent.id, isAdmin, companyId: pkg.company_id, companyName: pkg.company_name });
  }
  if (qlRef) {
    const rule = require('./quickline').simRuleFor(qlRef.packageId);
    const problem = rule && require('../quickline').simProblem(sim.iccid, rule);
    if (problem) fail(400, problem);
  }
  const customerPrice = optNum(body.customerPrice, 'سعر الزبون');
  if (customerPrice !== null && customerPrice < 0) fail(400, 'سعر الزبون لا يكون سالباً');

  // Direct companies: active at once and final. Manual companies: a request the manager carries out
  // (the manager's own sales count as already done). eSIM and number porting always go through the manager,
  // or through QuickLine for its packages. A QuickLine new line is never "direct": it must be activated there.
  // Anything sold on a QuickLine package (a new line, or an extension sold as a recharge) is carried out there.
  // A telecom new line is a request the manager carries out there, whoever sold it.
  const viaQl = !!qlRef || !!lyRef || /^(ql|ly|tcn?):/.test(pkg.art_card_id || '');
  const direct = D.directCompany(pkg.company_id) && !port && !esim && !viaQl;
  const manual = !direct && !port && !esim && !isAdmin;
  // The eSIM's QR code is kept with the task; it is shown on the line once QuickLine has activated it.
  const taskPayload = qlJob ? { ql: qlJob } : lyJob ? { ly: lyJob } : tcJob ? { tc: tcJob } : null;
  // A QuickLine sale is pending until QuickLine has carried it out, whoever sold it.
  const pending = port || esim || manual || viaQl;
  const t = now();
  const label = D.packageLabel(pkg);
  const customerName = str(body.customerName, 80);
  const initialQr = esim ? (qlJob?.qr || (pkg.esim_enabled && !viaQl ? require('../shop').makeEsimQr(`LPA:1$rsp.esim.portal$ESIM-${number}-${t}`, number) : '')) : '';
  const lineId = Number(q(`INSERT INTO lines (number, sim, company_id, package_id, package_label, agent_id, kind, esim, port, direct, months, days, price, cost,
                                              offer_id, status, customer_name, customer_price, note, activated_at, expires_at, updated_at, esim_qr)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(number, sim.iccid, pkg.company_id, pkg.id, label, agent.id, kind, esim ? 1 : 0, port ? 1 : 0, direct ? 1 : 0, months, days, total, cost,
      offer?.id ?? null, pending ? 'pending' : 'active', customerName, customerPrice, str(body.note, 300),
      t, pending ? null : periodEnd(t, months, days), t, initialQr).lastInsertRowid);
  D.markSimUsed(sim.stockId, lineId);
  if (sim.iccid) D.learnPrefix(pkg.company_id, sim.iccid);

  const detail = [durationText(months, days), offer ? `عرض: ${offer.title}` : '', kind === 'external' ? 'زبون دفع مسبق' : '',
    esim ? (esimFee ? `eSIM (رسوم ${esimFee} ₪)` : 'eSIM') : '', port ? 'تحويل رقم' : ''].filter(Boolean).join(' · ');
  D.changeBalance(agent, -total, {
    type: 'activate', actor: user, lineId, number, cost, profit: total - cost, detail, package: label, customerPrice,
  }, { charge: true });

  if (pending) {
    const type = port ? 'port' : esim ? 'esim' : kind === 'external' ? 'recharge' : 'activate';
    const what = { port: 'تحويل رقم', esim: 'تفعيل eSIM', recharge: 'زبون دفع مسبق', activate: 'تفعيل خط' }[type];
    // Everything the manager needs to carry it out on the company's site.
    const note = [`${what} ${number}`, label, durationText(months, days), sim.iccid ? `شريحة ${sim.iccid}` : '', customerName ? `الزبون: ${customerName}` : '']
      .filter(Boolean).join(' — ');
    D.openSaleTask({ type, agent, lineId, amount: total, note, payload: taskPayload });
  }
  return { line: view(lineId, user), balance: round(agent.balance), available: round(agent.balance + agent.credit_limit) };
}

// The packages that can renew a line, for the renew screen: its company's, on sale to its agent, and fitting who
// activates the line (quickline.renewalProblem). Worked out here so no screen needs to know the supplier.
route('GET', '/api/lines/:id/renew-options', ANY, ({ user, params }) => {
  const l = D.getLine(params.id, user);
  const { renewalProblem } = require('../quickline');
  const packageIds = q(`SELECT id, art_card_id FROM packages WHERE active = 1 AND company_id = ?
                          AND id NOT IN (SELECT package_id FROM agent_hidden WHERE agent_id = ?)`).all(l.company_id, l.agent_id)
    .filter((p) => !renewalProblem(l.package_ref, p.art_card_id)).map((p) => p.id);
  return { packageIds };
});

// ----- renewal (existing customer, or a card recharge on a known number) -----
route('POST', '/api/lines/:id/renew', ANY, ({ user, params, body }) => tx(() => renewLine(user, D.getLine(params.id, user), body)));

// Runs inside the caller's transaction.
function renewLine(user, l, body) {
  const isAdmin = user.role === 'admin';
  if (l.status === 'pending') fail(400, 'طلب هذا الرقم ما زال قيد التنفيذ');
  if (l.status === 'disconnected') fail(400, 'الرقم مفصول. فعّله من جديد من «اشتراك فاتورة جديدة».');
  const agent = D.getUser(l.agent_id);
  if (!agent.active) fail(403, 'حساب الوكيل موقوف');
  let months = int(Number(body.months ?? 1), 'المدة', 1, 24);
  const packageId = body.offerId ? null : body.packageId ?? l.package_id;
  if (!body.offerId && !packageId) fail(400, 'اختر الرزمة');
  const { pkg, offer, unit: quoted } = D.quote(agent.id, { packageId, offerId: body.offerId });
  if (l.company_id && pkg.company_id !== l.company_id) fail(400, `اختر رزمة من ${l.company_name}`);
  // A line is extended by its own supplier, on its own package there (see quickline.renewalProblem).
  const misfit = require('../quickline').renewalProblem(l.package_ref, pkg.art_card_id);
  if (misfit) fail(400, misfit);
  const days = pkg.days || null;
  if (days) months = 1;
  let unit = quoted;
  if (isAdmin && !isBlank(body.unitPrice)) unit = num(body.unitPrice, 'السعر');
  if (unit < 0) fail(400, 'السعر لا يكون سالباً');
  if (!isAdmin && !(unit > 0)) fail(400, 'لم يحدد المدير سعر هذه الرزمة بعد');
  const total = round(unit * months);
  const cost = round(pkg.cost * months);
  const customerPrice = optNum(body.customerPrice, 'سعر الزبون');

  const label = D.packageLabel(pkg);
  const card = body.kind === 'external';
  const renewal = { packageId: pkg.id, label, companyId: pkg.company_id, months, days, total, cost, offerId: offer?.id ?? null, customerPrice };
  // Manual companies: the agent pays now; the line is extended when the manager marks the request done.
  // A QuickLine extension is always carried out there (the manager's too), so it waits for QuickLine.
  const manual = (!isAdmin && !D.directCompany(pkg.company_id)) || /^(ql|ly|tc):/.test(pkg.art_card_id || '');
  if (!manual) applyRenewal(l.id, renewal);
  D.changeBalance(agent, -total, {
    type: 'renew', actor: user, lineId: l.id, number: l.number, cost, profit: total - cost, package: label, customerPrice,
    detail: [`تمديد ${durationText(months, days)}`, offer ? `عرض: ${offer.title}` : '', card ? 'زبون دفع مسبق' : '', manual ? 'بانتظار التنفيذ' : ''].filter(Boolean).join(' · '),
  }, { charge: true });
  if (manual) {
    const note = [`${card ? 'زبون دفع مسبق' : 'تمديد رزمة'} ${l.number}`, label, durationText(months, days), l.customer_name ? `الزبون: ${l.customer_name}` : '']
      .filter(Boolean).join(' — ');
    D.openSaleTask({ type: 'renew', agent, lineId: l.id, amount: total, note, payload: renewal });
  }
  return { line: view(l.id, user), pending: manual, balance: round(agent.balance), available: round(agent.balance + agent.credit_limit) };
}

// Extends a line by a renewal (now, or when the manager carries out a renewal request).
function applyRenewal(lineId, r) {
  const t = now();
  const l = q('SELECT expires_at FROM lines WHERE id = ?').get(lineId);
  q(`UPDATE lines SET package_id = ?, package_label = ?, company_id = ?, months = ?, days = ?, price = ?, cost = ?, offer_id = ?, expires_at = ?,
       customer_price = COALESCE(?, customer_price), updated_at = ? WHERE id = ?`)
    .run(r.packageId, r.label, r.companyId, r.months, r.days || null, r.total, r.cost, r.offerId,
      periodEnd(Math.max(t, l.expires_at || t), r.months, r.days), r.customerPrice, t, lineId);
}

// ----- freeze, unfreeze, disconnect, SIM swap -----
const ACTIONS = {
  freeze: { from: ['active'], to: 'frozen', label: 'تجميد الرقم' },
  unfreeze: { from: ['frozen'], to: 'active', label: 'إلغاء التجميد' },
  disconnect: { from: ['active', 'frozen'], to: 'disconnected', label: 'فصل الرقم' },
};
// The same change on QuickLine: disconnecting is its final disconnect, freezing its temporary one.
const QL_ACTION = { freeze: 'pause', unfreeze: 'activate', disconnect: 'close' };

route('POST', '/api/lines/:id/action', ANY, ({ user, params, body }) => tx(() => {
  const l = D.getLine(params.id, user);
  const agent = D.getUser(l.agent_id);
  const action = String(body.action);
  const reason = str(body.reason, 200);
  if (action === 'swap_sim') {
    if (!['active', 'frozen'].includes(l.status)) fail(400, 'لا يمكن تبديل شريحة هذا الرقم الآن');
    if (isBlank(body.sim) && !body.simId) fail(400, 'أدخل رقم الشريحة الجديدة');
    const sim = D.takeSim({ iccid: body.sim, simId: body.simId },
      { agentId: agent.id, isAdmin: user.role === 'admin', companyId: l.company_id, companyName: l.company_name });
    // A QuickLine line takes the new SIM there too, so it must fit QuickLine's rule for the company.
    const qlPkg = require('../quickline').supplierOfRef(l.package_ref).qlPackage;
    if (qlPkg) {
      const rule = require('./quickline').simRuleFor(qlPkg);
      const problem = rule && require('../quickline').simProblem(sim.iccid, rule);
      if (problem) fail(400, problem);
    }
    q('UPDATE lines SET sim = ?, esim = 0, updated_at = ? WHERE id = ?').run(sim.iccid, now(), l.id);
    D.markSimUsed(sim.stockId, l.id);
    if (l.company_id) D.learnPrefix(l.company_id, sim.iccid);
    D.logLineOp('swap_sim', l, agent, user, `${l.sim || 'بدون شريحة'} ← ${sim.iccid}${reason ? ' · ' + reason : ''}`, { package: l.package_label });
    if (qlPkg) {
      q('UPDATE lines SET ql_sim = ? WHERE id = ?').run(sim.iccid, l.id);
      D.events.emit('line-supplier', l.id);
    }
  } else {
    const a = ACTIONS[action];
    if (!a) fail(400, 'إجراء غير معروف');
    // A final disconnect is the manager's; an agent can freeze the number (a temporary disconnect) instead.
    if (action === 'disconnect' && user.role !== 'admin') fail(403, 'الفصل النهائي عند المدير. يمكنك تجميد الرقم (فصل مؤقت)، أو اطلب الفصل من المدير.');
    if (!a.from.includes(l.status)) fail(400, 'لا يمكن تنفيذ هذا الإجراء على حالة الرقم الحالية');
    q('UPDATE lines SET status = ?, updated_at = ? WHERE id = ?').run(a.to, now(), l.id);
    D.logLineOp(action, l, agent, user, a.label + (reason ? ' · ' + reason : ''), { package: l.package_label });
    // A QuickLine line changes there too, right after this commits (the latest change wins if several queue up).
    const ref = l.package_id ? q('SELECT art_card_id FROM packages WHERE id = ?').get(l.package_id)?.art_card_id : '';
    if (/^qln?:/.test(ref || '')) {
      q('UPDATE lines SET ql_pending = ? WHERE id = ?').run(QL_ACTION[action], l.id);
      D.events.emit('line-supplier', l.id);
    }
    // A Layan line's state is not changed there automatically yet: the manager is told to do it.
    if (/^lyn?:/.test(ref || '')) {
      D.notify({ role: 'admin', kind: 'task', title: `ليان: ${a.label} ${l.number}`, body: `غيّر حالة الرقم في ليان يدوياً (${a.label}).`, link: '#/tasks' });
    }
    if (/^tcn?:/.test(ref || '')) {
      D.notify({ role: 'admin', kind: 'task', title: `telecom: ${a.label} ${l.number}`, body: `غيّر حالة الرقم في telecom يدوياً (${a.label}).`, link: '#/tasks' });
    }
  }
  return { line: view(l.id, user) };
}));

// Customer details and notes; the manager may also correct the end date.
route('PUT', '/api/lines/:id', ANY, ({ user, params, body }) => {
  const l = D.getLine(params.id, user);
  const full = q('SELECT customer_price, expires_at FROM lines WHERE id = ?').get(l.id);
  const name = body.customerName === undefined ? l.customer_name : str(body.customerName, 80);
  const price = body.customerPrice === undefined ? full.customer_price : optNum(body.customerPrice, 'سعر الزبون');
  const note = body.note === undefined ? l.note : str(body.note, 300);
  const expires = user.role === 'admin' && body.expiresAt !== undefined ? dateOrNull(body.expiresAt) : full.expires_at;
  q('UPDATE lines SET customer_name = ?, customer_price = ?, note = ?, expires_at = ?, updated_at = ? WHERE id = ?')
    .run(name, price, note, expires, now(), l.id);
  return { line: view(l.id, user) };
});

// The manager corrects what an agent activated: number, package and/or the price charged.
// A price change charges or refunds the difference to the agent (it may go past the credit limit).
route('POST', '/api/lines/:id/correct', ADMIN, ({ user, params, body }) => tx(() => {
  const l = D.getLine(params.id, user);
  const agent = D.getUser(l.agent_id);
  const full = q('SELECT cost FROM lines WHERE id = ?').get(l.id);
  const changes = [];

  let number = l.number;
  if (!isBlank(body.number) && normalizePhone(body.number) !== l.number) {
    number = validPhone(normalizePhone(body.number));
    if (q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected' AND id != ?").get(number, l.id)) fail(409, `الرقم ${number} مفعّل على خط آخر`);
    changes.push(`الرقم ${l.number} ← ${number}`);
  }

  let pkg = null;
  let cost = full.cost;
  if (body.packageId && Number(body.packageId) !== l.package_id) {
    pkg = D.priceFor(agent.id, body.packageId);
    const old = l.package_id ? q('SELECT cost FROM packages WHERE id = ?').get(l.package_id) : null;
    // Keep any eSIM fee inside the cost: swap only the package part.
    cost = round(old ? full.cost - old.cost * l.months + pkg.cost * l.months : pkg.cost * l.months);
    changes.push(`الرزمة ${l.package_label} ← ${D.packageLabel(pkg)}`);
  }

  let price = l.price;
  if (!isBlank(body.price)) {
    price = num(body.price, 'السعر');
    if (price < 0) fail(400, 'السعر لا يكون سالباً');
    if (round(price) !== round(l.price)) changes.push(`السعر ${round(l.price)} ← ${round(price)} ₪`);
  }
  if (!changes.length) fail(400, 'لم يتغير شيء');

  const label = pkg ? D.packageLabel(pkg) : l.package_label;
  q('UPDATE lines SET number = ?, package_id = ?, package_label = ?, company_id = ?, price = ?, cost = ?, updated_at = ? WHERE id = ?')
    .run(number, pkg ? pkg.id : l.package_id, label, pkg ? pkg.company_id : l.company_id, price, cost, now(), l.id);
  const detail = `تعديل المدير: ${changes.join(' · ')}${body.reason ? ' · ' + str(body.reason, 200) : ''}`;
  const priceDelta = round(price - l.price);
  const costDelta = round(cost - full.cost);
  if (priceDelta || costDelta) {
    D.changeBalance(agent, -priceDelta, {
      type: 'line_edit', actor: user, lineId: l.id, number, cost: costDelta, profit: priceDelta - costDelta, package: label, detail,
    });
  } else {
    D.logLineOp('line_edit', { ...l, number }, agent, user, detail, { package: label });
  }
  D.notify({ userId: agent.id, kind: 'line', title: `عدّل المدير الخط ${number}`, body: changes.join(' · '), link: '#/subscribers' });
  return { line: view(l.id, user), balance: round(agent.balance) };
}));

route('POST', '/api/lines/:id/move', ADMIN, ({ user, params, body }) => tx(() => {
  const l = D.getLine(params.id, user);
  const from = D.getUser(l.agent_id);
  const to = D.getAgent(body.toAgentId);
  if (to.id === from.id) fail(400, 'اختر وكيلاً آخر');
  const detail = `نقل من ${from.name} إلى ${to.name}`;
  if (body.withMoney) {
    D.changeBalance(to, -l.price, { type: 'line_move', actor: user, lineId: l.id, number: l.number, detail }, { charge: true });
    D.changeBalance(from, l.price, { type: 'line_move', actor: user, lineId: l.id, number: l.number, detail });
  } else {
    D.logLineOp('line_move', l, to, user, detail);
  }
  q('UPDATE lines SET agent_id = ?, updated_at = ? WHERE id = ?').run(to.id, now(), l.id);
  D.notify({ userId: to.id, kind: 'line', title: `أُضيف الرقم ${l.number} إلى حسابك`, body: l.package_label, link: '#/subscribers' });
  D.notify({ userId: from.id, kind: 'line', title: `نُقل الرقم ${l.number} من حسابك`, body: `إلى ${to.name}`, link: '#/subscribers' });
  return { line: view(l.id, user) };
}));

// Removes a line entered by mistake. A SIM taken from stock goes back to stock.
route('DELETE', '/api/lines/:id', ADMIN, ({ user, params, query }) => tx(() => {
  const l = D.getLine(params.id, user);
  // A request a supplier is carrying out right now would be lost (and possibly refunded) while it is delivered.
  if (q("SELECT 1 FROM tasks WHERE line_id = ? AND status = 'open' AND auto_status IN ('sending','sent')").get(l.id)) {
    fail(409, 'لهذا الخط طلب يُنفَّذ الآن عند المورّد — انتظر نتيجته قبل الحذف');
  }
  const agent = D.getUser(l.agent_id);
  if (query.refund === '1') {
    D.changeBalance(agent, l.price, { type: 'line_delete', actor: user, number: l.number, cost: -l.cost, profit: -(l.price - l.cost),
      package: l.package_label, detail: 'حذف الخط مع إرجاع المبلغ' });
  } else {
    D.logLineOp('line_delete', l, agent, user, 'حذف الخط');
  }
  q("UPDATE sims SET status = 'available', line_id = NULL, used_at = NULL WHERE line_id = ?").run(l.id);
  q("DELETE FROM tasks WHERE line_id = ? AND status = 'open'").run(l.id);
  q('DELETE FROM lines WHERE id = ?').run(l.id);
  return { ok: true };
}));

module.exports = { monthsText, applyRenewal, createLine };
