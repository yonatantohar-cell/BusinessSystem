/**
 * Grow (payment provider) webhook receiver + feed for קופה קיוסק בריכה.
 *
 * doPost — Grow calls this on every approved transaction (JSON or form payload).
 * doGet  — the POS app polls this to fetch transactions newer than `since`.
 *
 * Storage: a Google Sheet the script creates by itself on the first webhook
 * ("Grow Payments Log" in your Drive) — also a human-readable audit log.
 *
 * SETUP: change KEY below to a long random secret of your own, then deploy
 * as a Web App (execute as: Me, access: Anyone). The same key goes in the
 * Grow webhook URL (?key=...) and in the POS app settings.
 */

const KEY = 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';
const MAX_ROWS = 500;   // keep the sheet from growing forever

function getSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create('Grow Payments Log');
    props.setProperty('SHEET_ID', ss.getId());
    ss.getActiveSheet().appendRow(['ts', 'name', 'amount', 'ref', 'raw']);
  }
  return ss.getActiveSheet();
}

function doPost(e) {
  try {
    if (((e && e.parameter && e.parameter.key) || '') !== KEY) {
      return json_({ ok: false, error: 'bad key' });
    }
    // Grow may send JSON or form fields; some payloads nest under "data"
    let p = {};
    if (e.postData && e.postData.contents) {
      try { p = JSON.parse(e.postData.contents); } catch (err) { p = e.parameter || {}; }
    } else {
      p = e.parameter || {};
    }
    const d = p.data || p;
    const name = String(d.fullName || d.payerName || d.customerName || d.name || '').trim();
    const amount = parseFloat(d.sum || d.amount || d.transactionSum || d.price || 0) || 0;
    const ref = String(d.asmachta || d.transactionId || d.paymentId || d.id || Date.now());

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = getSheet_();
      sheet.appendRow([Date.now(), name, amount, ref, JSON.stringify(p).slice(0, 2000)]);
      const extra = sheet.getLastRow() - 1 - MAX_ROWS;
      if (extra > 0) sheet.deleteRows(2, extra);
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    if (((e && e.parameter && e.parameter.key) || '') !== KEY) {
      return json_({ ok: false, error: 'bad key' });
    }
    const since = Number((e.parameter && e.parameter.since) || 0);
    const sheet = getSheet_();
    const last = sheet.getLastRow();
    const rows = last > 1 ? sheet.getRange(2, 1, last - 1, 4).getValues() : [];
    const pays = rows
      .filter(function (r) { return Number(r[0]) > since; })
      .map(function (r) {
        return { ts: Number(r[0]), name: String(r[1]), amount: Number(r[2]), ref: String(r[3]) };
      })
      .slice(-100);
    return json_({ ok: true, pays: pays });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
