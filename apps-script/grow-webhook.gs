/**
 * Incanto — Grow webhook receiver + digital menu + self-ordering backend.
 * One Google Apps Script Web App serves everything, 100% free:
 *
 *   doPost (webhook from Grow)      — logs approved payments, auto-matches pending orders
 *   doPost ?action=neworder         — customer places an order (public), returns order number
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
const VERSION = 2;           // bumped with the script; the app checks this to catch a stale deployment
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
  const others = ss.getSheets().filter(function (s) { return s.getName() !== 'orders'; });
  return others[0] || ss.getSheets()[0];
}

function ordersSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName('orders');
  if (!sh) {
    sh = ss.insertSheet('orders', ss.getNumSheets());   // always appended last
    sh.appendRow(['created', 'order', 'name', 'phone', 'items', 'total', 'paid', 'payref']);
  }
  return sh;
}

function menuFile_() {
  const props = props_();
  const id = props.getProperty('MENU_FILE_ID');
  if (id) { try { return DriveApp.getFileById(id); } catch (e) {} }
  const f = DriveApp.createFile('incanto-menu.json',
    JSON.stringify({ config: {}, items: [] }), 'application/json');
  props_().setProperty('MENU_FILE_ID', f.getId());
  return f;
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
      return json_({ ok: true, version: VERSION });
    }

    if (action === 'menu') {   // public: the published digital menu
      return ContentService.createTextOutput(menuFile_().getBlob().getDataAsString())
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'orderstatus') {   // public: one order's paid state only
      const o = findOrderRow_(String(p.order || ''));
      return o ? json_({ ok: true, order: o.order, paid: o.paid ? 1 : 0 })
               : json_({ ok: false, error: 'not found' });
    }

    if ((p.key || '') !== KEY) return json_({ ok: false, error: 'bad key' });

    if (action === 'orders') {   // POS feed: recent orders (created or updated)
      return json_({ ok: true, orders: listOrders_() });
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

    if ((p0.key || '') !== KEY) return json_({ ok: false, error: 'bad key' });

    if (action === 'savemenu') {   // admin publishes the menu
      const menu = body.menu || {};
      menuFile_().setContent(JSON.stringify(menu));
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
    sh.appendRow([Date.now(), orderNo, String(body.name || '').slice(0, 60),
      String(body.phone || '').slice(0, 30), itemsTxt, total, 0, '']);
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
  return last > 1 ? sh.getRange(2, 1, last - 1, 8).getValues() : [];
}

function listOrders_() {
  const cutoff = Date.now() - ORDERS_FEED_HOURS * 3600 * 1000;
  return ordersRows_()
    .filter(function (r) { return Number(r[0]) > cutoff; })
    .map(function (r) {
      return { created: Number(r[0]), order: String(r[1]), name: String(r[2]), phone: String(r[3]),
               items: String(r[4]), total: Number(r[5]), paid: Number(r[6]) ? 1 : 0, payref: String(r[7]) };
    })
    .slice(-150);
}

function findOrderRow_(orderNo) {
  if (!orderNo) return null;
  const rows = ordersRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]) === orderNo) {
      return { row: i + 2, order: orderNo, total: Number(rows[i][5]), paid: Number(rows[i][6]) };
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
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
