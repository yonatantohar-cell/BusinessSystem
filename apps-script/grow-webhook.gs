/**
 * Incanto — Grow webhook receiver + digital menu + self-ordering backend.
 * One Google Apps Script Web App serves everything, 100% free:
 *
 *   doPost (webhook from Grow)      — logs approved payments, auto-matches pending orders
 *   doPost ?action=neworder         — customer places an order (public), returns order number
 *   doPost ?action=confirmpaid      — customer finished the online payment (public)
 *   doPost ?action=savemenu&key=..  — admin publishes the digital menu (stored in Drive)
 *   doGet  ?action=menu             — customers fetch the published menu (public)
 *   doGet  ?action=orderstatus      — customer polls one order's paid status (public)
 *   doGet  ?action=orders&key=..    — POS fetches recent orders (protected)
 *   doGet  ?key=..&since=..         — POS fetches payments feed (protected, unchanged)
 *
 * SETUP: set KEY to your long random secret (keep your existing one when
 * updating). Deploy as Web App: Execute as Me, access: Anyone. After code
 * updates: Deploy → Manage deployments → ✎ → New version (URL stays the same).
 */

const KEY = 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';
const VERSION = 6;           // bumped with the script; the app checks this to catch a stale deployment
const MAX_ROWS = 500;        // payments log cap
const MAX_ORDER_ROWS = 400;  // orders log cap
const ORDERS_FEED_HOURS = 48;

/* ================= storage ================= */

function props_() { return PropertiesService.getScriptProperties(); }

function ss_() {
  const props = props_();
  const id = props.getProperty('SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create('Grow Payments Log');
    props.setProperty('SHEET_ID', ss.getId());
    ss.getSheets()[0].appendRow(['ts', 'name', 'amount', 'ref', 'raw']);
  }
  return ss;
}

/* the original (first) sheet is the payments log — identify it by exclusion so
   adding tabs can never redirect payment rows into the wrong sheet */
function paymentsSheet_() {
  const ss = ss_();
  const named = ss.getSheetByName('payments');
  if (named) return named;
  const others = ss.getSheets().filter(function (s) {
    return s.getName() !== 'orders' && s.getName() !== 'menu';
  });
  return others[0] || ss.getSheets()[0];
}

function ordersSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName('orders');
  if (!sh) {
    sh = ss.insertSheet('orders', ss.getNumSheets());   // always appended last
    sh.appendRow(['created', 'order', 'name', 'phone', 'items', 'total', 'paid', 'payref', 'method', 'state', 'email', 'token']);
  }
  return sh;
}

/* The menu lives in a 'menu' tab of the same spreadsheet, split across rows.
   Deliberately NOT in Drive: DriveApp would need an OAuth scope this script
   never had, and a web app cannot prompt the owner to grant one — it just
   fails. SpreadsheetApp is already authorized, so publishing needs no extra
   permission. A cell holds 50k chars; chunks are marked so a chunk that
   happens to start with '=' is never parsed as a formula. */
const MENU_CHUNK = 40000;
const MENU_MARK = '~';
const EMPTY_MENU = '{"config":{},"items":[]}';

function menuSheet_() {
  const ss = ss_();
  return ss.getSheetByName('menu') || ss.insertSheet('menu', ss.getNumSheets());
}

function readMenu_() {
  const sh = menuSheet_();
  const last = sh.getLastRow();
  if (last < 1) return EMPTY_MENU;
  const rows = sh.getRange(1, 1, last, 1).getValues();
  const out = rows.map(function (r) {
    const s = String(r[0] == null ? '' : r[0]);
    return s.charAt(0) === MENU_MARK ? s.substring(1) : s;
  }).join('');
  return out || EMPTY_MENU;
}

function writeMenu_(str) {
  const sh = menuSheet_();
  sh.clear();
  const chunks = [];
  for (var i = 0; i < str.length; i += MENU_CHUNK) {
    chunks.push([MENU_MARK + str.substr(i, MENU_CHUNK)]);
  }
  if (chunks.length) sh.getRange(1, 1, chunks.length, 1).setValues(chunks);
}

/**
 * Optional: press Run on this function in the editor to verify storage works
 * and to see the result in the execution log. Not needed for normal operation.
 */
function setup() {
  const before = readMenu_().length;
  writeMenu_(readMenu_());
  Logger.log('OK — version %s, menu bytes: %s, orders rows: %s',
    VERSION, before, Math.max(0, ordersSheet_().getLastRow() - 1));
}


/* ================= Green Invoice (Morning) API =================
   Credentials live in Script Properties, never in this file:
     Project Settings → Script properties → add
       GI_API_KEY     = your API key
       GI_API_SECRET  = your API secret
   Run giTest() once from the editor: it triggers the external-request
   authorization prompt and prints the raw API responses to the log, so any
   field-name mismatch is visible immediately instead of failing silently. */

const GI_BASE = 'https://api.greeninvoice.co.il/api/v1';

function giCreds_() {
  const p = props_();
  return { key: p.getProperty('GI_API_KEY') || '', secret: p.getProperty('GI_API_SECRET') || '' };
}
function giReady_() { const c = giCreds_(); return !!(c.key && c.secret); }

/* JWT, cached until shortly before it expires */
function giToken_() {
  const p = props_();
  const cached = p.getProperty('GI_TOKEN');
  if (cached && Number(p.getProperty('GI_TOKEN_EXP') || 0) > Date.now() + 60000) return cached;
  const c = giCreds_();
  if (!c.key || !c.secret) throw new Error('GI credentials missing (Script properties GI_API_KEY / GI_API_SECRET)');
  const res = UrlFetchApp.fetch(GI_BASE + '/account/token', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ id: c.key, secret: c.secret }), muteHttpExceptions: true
  });
  const txt = res.getContentText();
  var j = {};
  try { j = JSON.parse(txt); } catch (e) {}
  if (!j.token) throw new Error('GI token failed (HTTP ' + res.getResponseCode() + '): ' + txt.slice(0, 200));
  p.setProperty('GI_TOKEN', j.token);
  p.setProperty('GI_TOKEN_EXP', String(Date.now() + 25 * 60 * 1000));
  return j.token;
}

function execUrl_() { return ScriptApp.getService().getUrl(); }

/* create a hosted payment page for one order and return its URL */
function giPaymentUrl_(o, returnTo) {
  const token = giToken_();
  const back = execUrl_() + '?action=paid&order=' + encodeURIComponent(o.order) +
               '&t=' + encodeURIComponent(o.token) +
               (returnTo ? '&back=' + encodeURIComponent(returnTo) : '');
  const payload = {
    description: 'הזמנה ' + o.order,
    type: 400,                       // payment request; adjust if your account uses another document type
    lang: 'he',
    currency: 'ILS',
    vatType: 0,
    amount: o.total,
    maxPayments: 1,
    client: { name: o.name || 'לקוח', emails: o.email ? [o.email] : [], phone: o.phone || '' },
    income: [{ description: 'הזמנה ' + o.order, quantity: 1, price: o.total, currency: 'ILS', vatType: 0 }],
    remarks: 'הזמנה ' + o.order,
    successUrl: back,
    failureUrl: back + '&failed=1',
    notifyUrl: execUrl_() + '?action=ginotify'
  };
  const res = UrlFetchApp.fetch(GI_BASE + '/payments/form', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const txt = res.getContentText();
  var j = {};
  try { j = JSON.parse(txt); } catch (e) {}
  if (!j.url) throw new Error('GI form failed (HTTP ' + res.getResponseCode() + '): ' + txt.slice(0, 300));
  return j.url;
}

/**
 * Run this once from the editor after adding the credentials:
 *  - triggers the authorization prompt for external requests
 *  - verifies the credentials and prints the payment-page response
 * Check View → Executions / the log for the result.
 */
function giTest() {
  Logger.log('credentials present: %s', giReady_());
  Logger.log('token ok: %s', giToken_().slice(0, 12) + '…');
  const url = giPaymentUrl_({ order: 'TEST', total: 1, name: 'בדיקה', email: '', phone: '', token: 'test' }, '');
  Logger.log('payment page: %s', url);
}

/* ================= tolerant payload parsing ================= */

var AMOUNT_KEYS = ['sum', 'amount', 'paymentsum', 'transactionsum', 'firstpaymentsum', 'payment_sum', 'price', 'total'];
var NAME_KEYS = ['fullname', 'payername', 'customername', 'clientname', 'name', 'firstname'];
var REF_KEYS = ['asmachta', 'transactionid', 'transaction_id', 'paymentid', 'payment_id', 'processid', 'id'];
// custom-field keys that may carry our order number back from the Grow payment page
var ORDER_KEYS = ['cfield1', 'cfield2', 'cfield', 'custom1', 'custom', 'orderid', 'order_id', 'ordernum', 'order'];

function unflatten_(params) {
  var out = {};
  Object.keys(params || {}).forEach(function (k) {
    var m = k.match(/^(\w+)\[(\w+)\]$/);   // data[sum] → {data:{sum:...}}
    if (m) { out[m[1]] = out[m[1]] || {}; out[m[1]][m[2]] = params[k]; }
    else out[k] = params[k];
  });
  return out;
}

function deepFind_(obj, keys, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  var k;
  for (k in obj) {
    if (keys.indexOf(String(k).toLowerCase()) >= 0 && obj[k] !== '' && obj[k] != null && typeof obj[k] !== 'object') {
      return obj[k];
    }
  }
  for (k in obj) {
    if (obj[k] && typeof obj[k] === 'object') {
      var r = deepFind_(obj[k], keys, depth + 1);
      if (r != null) return r;
    }
  }
  return null;
}

function toAmount_(v) {
  if (v == null) return 0;
  var n = parseFloat(String(v).replace(/[^\d.,\-]/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

/* ================= entry points ================= */

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || '').toLowerCase();

    if (action === 'ping') {   // public: proves which script version is actually deployed
      return json_({ ok: true, version: VERSION, gi: giReady_() });
    }

    if (action === 'menu') {   // public: the published digital menu
      return ContentService.createTextOutput(readMenu_())
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'paid') {   // return trip from the payment page
      const o = findOrderRow_(String(p.order || ''));
      const good = o && o.token && String(p.t || '') === o.token && !p.failed;
      if (good) {
        const sh = ordersSheet_();
        sh.getRange(o.row, 7).setValue(1);
        sh.getRange(o.row, 10).setValue('active');       // confirmed → straight to the kitchen board
        if (!String(sh.getRange(o.row, 8).getValue())) sh.getRange(o.row, 8).setValue('greeninvoice');
      }
      const back = String(p.back || '');
      const msg = good ? 'התשלום התקבל — ההזמנה נכנסה להכנה' : 'התשלום לא הושלם';
      return HtmlService.createHtmlOutput(
        '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        (back ? '<meta http-equiv="refresh" content="2;url=' + back.replace(/"/g, '&quot;') +
                (back.indexOf('?') >= 0 ? '&' : '?') + 'paid=' + (good ? '1' : '0') + '">' : '') +
        '<body style="font-family:system-ui;text-align:center;padding:60px 20px">' +
        '<h2>' + msg + '</h2><p>הזמנה #' + String(p.order || '') + '</p></body></html>');
    }

    if (action === 'ginotify') {   // provider callback (configured as notifyUrl)
      return json_({ ok: true });
    }

    if (action === 'orderstatus') {   // public: one order's paid state only
      const o = findOrderRow_(String(p.order || ''));
      return o ? json_({ ok: true, order: o.order, paid: o.paid ? 1 : 0 })
               : json_({ ok: false, error: 'not found' });
    }

    if ((p.key || '') !== KEY) return json_({ ok: false, error: 'bad key' });

    if (action === 'orders') {   // POS board: confirmed orders only
      return json_({ ok: true, orders: listOrders_('active') });
    }

    if (action === 'pending') {   // manager view: online orders awaiting payment confirmation
      return json_({ ok: true, orders: listOrders_('pending_gateway') });
    }

    // default: payments feed (unchanged behavior)
    const since = Number(p.since || 0);
    const sheet = paymentsSheet_();
    const last = sheet.getLastRow();
    const rows = last > 1 ? sheet.getRange(2, 1, last - 1, 4).getValues() : [];
    const pays = rows
      .filter(function (r) { return Number(r[0]) > since; })
      .map(function (r) { return { ts: Number(r[0]), name: String(r[1]), amount: Number(r[2]), ref: String(r[3]) }; })
      .slice(-100);
    return json_({ ok: true, pays: pays });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const p0 = (e && e.parameter) || {};
    let body = {};
    if (e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); }
      catch (err) { body = unflatten_(p0); }
    } else {
      body = unflatten_(p0);
    }
    const action = String(p0.action || body.action || '').toLowerCase();

    if (action === 'neworder') return newOrder_(body);          // public

    if (action === 'paylink') {   // public: hosted payment page for an existing order
      if (!giReady_()) return json_({ ok: false, error: 'gi not configured' });
      const o = findOrderRow_(String(body.order || ''));
      if (!o) return json_({ ok: false, error: 'not found' });
      try {
        return json_({ ok: true, url: giPaymentUrl_(o, String(body.back || '')) });
      } catch (err) {
        return json_({ ok: false, error: String(err).slice(0, 300) });
      }
    }

    if (action === 'confirmpaid') {   // public: customer says they finished the payment page
      const t = findOrderRow_(String(body.order || ''));
      if (!t) return json_({ ok: false, error: 'not found' });
      const sh = ordersSheet_();
      // a customer claim alone never reaches the kitchen; it is recorded so the
      // manager sees it in the pending list, and the webhook (or the manager) releases it
      if (!String(sh.getRange(t.row, 8).getValue())) sh.getRange(t.row, 8).setValue('customer-claim');
      return json_({ ok: true, order: t.order });
    }

    if (action === 'release') {   // manager releases a pending online order (key protected below)
      if ((p0.key || '') !== KEY) return json_({ ok: false, error: 'bad key' });
      return json_({ ok: releaseOrder_(String(body.order || ''), body.paid ? 1 : 0) });
    }

    if ((p0.key || '') !== KEY) return json_({ ok: false, error: 'bad key' });

    if (action === 'savemenu') {   // admin publishes the menu
      const menu = body.menu || {};
      writeMenu_(JSON.stringify(menu));
      // echo version + count so the app can prove the new code handled this, not an old deployment
      return json_({ ok: true, version: VERSION, items: (menu.items || []).length });
    }

    // default: Grow webhook — log the payment, then try to mark a matching order paid
    const name = String(deepFind_(body, NAME_KEYS, 0) || '').trim();
    const amount = toAmount_(deepFind_(body, AMOUNT_KEYS, 0));
    const ref = String(deepFind_(body, REF_KEYS, 0) || Date.now());
    const orderNo = String(deepFind_(body, ORDER_KEYS, 0) || '');

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = paymentsSheet_();
      sheet.appendRow([Date.now(), name, amount, ref, JSON.stringify(body).slice(0, 2000)]);
      const extra = sheet.getLastRow() - 1 - MAX_ROWS;
      if (extra > 0) sheet.deleteRows(2, extra);
      markOrderPaid_(orderNo, amount, ref);
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ================= orders ================= */

function newOrder_(body) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
  const total = toAmount_(body.total);
  if (!items.length || !(total >= 0)) return json_({ ok: false, error: 'bad order' });
  const itemsTxt = items.map(function (i) {
    return String(i.name || '?').slice(0, 40) + '×' + (Number(i.qty) || 1);
  }).join(', ').slice(0, 900);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var orderNo;
  try {
    const n = Number(props_().getProperty('ORDER_SEQ') || '100') + 1;
    props_().setProperty('ORDER_SEQ', String(n));
    orderNo = String(n);
    const sh = ordersSheet_();
    const method = String(body.payMethod || 'counter') === 'online' ? 'online' : 'counter';
    const state = method === 'online' ? 'pending_gateway' : 'active';
    sh.appendRow([Date.now(), orderNo, String(body.name || '').slice(0, 60),
      String(body.phone || '').slice(0, 30), itemsTxt, total, 0, '', method, state,
      String(body.email || '').slice(0, 80), Utilities.getUuid()]);
    const extra = sh.getLastRow() - 1 - MAX_ORDER_ROWS;
    if (extra > 0) sh.deleteRows(2, extra);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, order: orderNo });
}

function ordersRows_() {
  const sh = ordersSheet_();
  const last = sh.getLastRow();
  return last > 1 ? sh.getRange(2, 1, last - 1, 12).getValues() : [];
}

function listOrders_(wantState) {
  const cutoff = Date.now() - ORDERS_FEED_HOURS * 3600 * 1000;
  const want = wantState || 'active';
  return ordersRows_()
    .filter(function (r) { return Number(r[0]) > cutoff && String(r[9] || 'active') === want; })
    .map(function (r) {
      return { created: Number(r[0]), order: String(r[1]), name: String(r[2]), phone: String(r[3]),
               items: String(r[4]), total: Number(r[5]), paid: Number(r[6]) ? 1 : 0, payref: String(r[7]),
               method: String(r[8] || 'counter'), state: String(r[9] || 'active'), email: String(r[10] || '') };
    })
    .slice(-150);
}

function findOrderRow_(orderNo) {
  if (!orderNo) return null;
  const rows = ordersRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]) === orderNo) {
      return { row: i + 2, order: orderNo, total: Number(rows[i][5]), paid: Number(rows[i][6]),
               name: String(rows[i][2]), email: String(rows[i][10] || ''), phone: String(rows[i][3]),
               token: String(rows[i][11] || '') };
    }
  }
  return null;
}

/* mark an order paid: by order number from the payment's custom field,
   otherwise best-effort — newest unpaid order with the same total in the last 20 min */
function markOrderPaid_(orderNo, amount, ref) {
  const sh = ordersSheet_();
  var target = findOrderRow_(orderNo);
  if (!target || target.paid) {
    target = null;
    const rows = ordersRows_();
    const cutoff = Date.now() - 20 * 60 * 1000;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (!Number(rows[i][6]) && Number(rows[i][0]) > cutoff && Math.abs(Number(rows[i][5]) - amount) < 0.01) {
        target = { row: i + 2 }; break;
      }
    }
  }
  if (target) {
    sh.getRange(target.row, 7).setValue(1);
    sh.getRange(target.row, 8).setValue(String(ref || ''));
    sh.getRange(target.row, 10).setValue('active');   // confirmed → appears on the POS board
  }
}

/* release a pending online order onto the board by hand (manager decision) */
function releaseOrder_(orderNo, paid) {
  const t = findOrderRow_(orderNo);
  if (!t) return false;
  const sh = ordersSheet_();
  sh.getRange(t.row, 10).setValue('active');
  if (paid) sh.getRange(t.row, 7).setValue(1);
  return true;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
