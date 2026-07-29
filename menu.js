/* =========================================================
   Incanto — customer digital menu + self-ordering controller
   Loaded by menu.html. The backend is the same Google Apps
   Script Web App that handles the Grow webhook; its URL is
   passed in the QR link:  menu.html?api=<script /exec URL>
   ========================================================= */
'use strict';

const API = new URLSearchParams(location.search).get('api') || '';
const ILS = n => '₪' + (Math.round(n * 100) / 100).toLocaleString('he-IL');
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const api = (params) => API + (API.includes('?') ? '&' : '?') + params;

let MENU = { config: {}, items: [] };
let cart = {};              // itemId -> qty
let activeCat = null;
let currentOrder = null;    // {order, total}
let statusTimer = null;
let apiPayReady = false;   // backend can create payment pages through the provider API

/* ---------- load menu ----------
   Failures here are almost always configuration, not networking, so the
   message names the actual cause instead of a generic "try again". */
function menuError(msg, detail) {
  $('stateMsg').innerHTML = msg + (detail ? `<br><span style="font-size:12px;opacity:.6">${esc(String(detail).slice(0, 120))}</span>` : '');
}

async function loadMenu() {
  if (!API || !/^https:\/\/script\.google\.com\/macros\//.test(API)) {
    menuError('קישור התפריט חסר או שגוי.<br>יש לסרוק שוב את קוד ה-QR של העסק.');
    return;
  }
  if (/\/dev(\?|$)/.test(API)) {
    // the /dev deployment always demands the owner's Google login — it can never serve customers
    menuError('הקישור מצביע על כתובת בדיקה (/dev) שדורשת התחברות.<br>על בעל העסק להשתמש בכתובת ה-Web app שמסתיימת ב-<b>/exec</b>.');
    return;
  }
  let res, txt;
  try {
    res = await fetch(api('action=menu'));
    txt = await res.text();
  } catch (e) {
    menuError('אין חיבור לשרת התפריט.<br>בדקו את החיבור לאינטרנט ונסו לרענן.', e.message);
    return;
  }
  let data = null;
  try { data = JSON.parse(txt); } catch (e) { /* not JSON — diagnosed below */ }
  if (!data) {
    // Apps Script served HTML: a Google sign-in/consent page, a dead URL, or an error page.
    const login = /accounts\.google\.com|ServiceLogin|Sign in|התחברות/i.test(txt);
    if (res.status === 404) {
      // the deployment behind this link no longer exists (a new deployment was created,
      // so the id in /s/…/exec changed) or the address carries a stray trailing slash
      menuError('קישור התפריט מצביע על כתובת שאינה קיימת יותר.<br>יש לסרוק מחדש את קוד ה-QR / לבקש קישור מעודכן מבעל העסק.',
        'HTTP 404');
      return;
    }
    menuError(login
      ? 'שרת התפריט מבקש התחברות לחשבון Google.<br>על בעל העסק להגדיר בפריסת ה-Apps Script: <b>Who has access: Anyone</b>, ולהשתמש בכתובת <b>/exec</b>.'
      : 'שרת התפריט החזיר תשובה לא תקינה.<br>על בעל העסק לבדוק את פריסת ה-Apps Script.',
      'HTTP ' + res.status);
    return;
  }
  if (data.ok === false) {
    // the new backend answers action=menu publicly; "bad key" can only come from the old v1 script
    menuError(data.error === 'bad key'
      ? 'בשרת של העסק פועלת גרסה ישנה של הסקריפט.<br>על בעל העסק לעדכן את קוד ה-Apps Script ולפרוס גרסה חדשה.'
      : 'שרת התפריט דחה את הבקשה.', data.error);
    return;
  }
  if (!Array.isArray(data.items)) { menuError('התפריט טרם פורסם.<br>על בעל העסק ללחוץ "פרסום התפריט" באזור המנהל.'); return; }
  MENU = data;
  MENU.config = MENU.config || {};
  if (MENU.config.name) { $('bizName').textContent = MENU.config.name; document.title = MENU.config.name + ' · תפריט'; }
  renderMenu();
  // does the backend have API payments configured? enables online checkout even
  // when no static payment link is set
  fetch(api('action=ping')).then(r => r.json()).then(j => {
    if (j && j.gi) { apiPayReady = true; renderCartBits(); }
  }).catch(() => {});
}

function cats() {
  const seen = [];
  MENU.items.forEach(i => { const c = i.cat || 'כללי'; if (i.avail !== false && !seen.includes(c)) seen.push(c); });
  return seen;
}

function renderMenu() {
  const items = MENU.items.filter(i => i.avail !== false);
  if (!items.length) { $('stateMsg').textContent = 'התפריט ריק כרגע — נשוב בקרוב!'; return; }

  const catList = cats();
  if (!activeCat || !catList.includes(activeCat)) activeCat = null;
  $('cats').innerHTML = ['<button class="cat' + (activeCat === null ? ' on' : '') + '" data-cat="">הכול</button>']
    .concat(catList.map(c => `<button class="cat${activeCat === c ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`)).join('');
  $('cats').querySelectorAll('.cat').forEach(b => b.onclick = () => { activeCat = b.dataset.cat || null; renderMenu(); });

  const main = $('menuMain');
  main.innerHTML = '';
  (activeCat ? [activeCat] : catList).forEach(c => {
    const sec = document.createElement('section');
    sec.innerHTML = `<h3 class="cat-title">${esc(c)}</h3>`;
    items.filter(i => (i.cat || 'כללי') === c).forEach(it => {
      const q = cart[it.id] || 0;
      const d = document.createElement('article');
      d.className = 'dish';
      d.innerHTML = `
        ${it.img ? `<img src="${it.img}" alt="${esc(it.name)}">` : '<div class="noimg" aria-hidden="true">🍽</div>'}
        <div class="info">
          <div class="nm">${esc(it.name)}</div>
          ${it.desc ? `<div class="ds">${esc(it.desc)}</div>` : ''}
          <div class="pr">${ILS(it.price)}</div>
        </div>
        <div class="act">${q === 0
          ? `<button class="addbtn" data-add="${it.id}" aria-label="הוספת ${esc(it.name)}">＋</button>`
          : `<div class="qtyrow"><button data-add="${it.id}" aria-label="עוד אחד">＋</button><b>${q}</b><button data-sub="${it.id}" aria-label="הפחתה">−</button></div>`}
        </div>`;
      sec.appendChild(d);
    });
    main.appendChild(sec);
  });
  main.querySelectorAll('[data-add]').forEach(b => b.onclick = () => { cart[b.dataset.add] = (cart[b.dataset.add] || 0) + 1; renderMenu(); renderCartBits(); });
  main.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { cart[b.dataset.sub]--; if (cart[b.dataset.sub] <= 0) delete cart[b.dataset.sub]; renderMenu(); renderCartBits(); });
  renderCartBits();
}

/* ---------- cart ---------- */
const cartItems = () => Object.keys(cart).map(id => {
  const it = MENU.items.find(i => i.id === id);
  return it ? { it, qty: cart[id] } : null;
}).filter(Boolean);
const cartTotal = () => cartItems().reduce((s, l) => s + l.it.price * l.qty, 0);
const cartCount = () => cartItems().reduce((s, l) => s + l.qty, 0);

function renderCartBits() {
  const n = cartCount();
  $('cartBar').classList.toggle('show', n > 0);
  $('cartCnt').textContent = n;
  $('cartBarTotal').textContent = ILS(cartTotal());

  const lines = $('cartLines');
  lines.innerHTML = cartItems().map(l => `
    <div class="cline">
      <span class="nm">${esc(l.it.name)}</span>
      <div class="qtyrow"><button data-cadd="${l.it.id}" aria-label="עוד">＋</button><b>${l.qty}</b><button data-csub="${l.it.id}" aria-label="פחות">−</button></div>
      <span class="pr">${ILS(l.it.price * l.qty)}</span>
    </div>`).join('') || '<p class="mini" style="padding:14px 0">הסל ריק</p>';
  lines.querySelectorAll('[data-cadd]').forEach(b => b.onclick = () => { cart[b.dataset.cadd]++; renderMenu(); });
  lines.querySelectorAll('[data-csub]').forEach(b => b.onclick = () => { cart[b.dataset.csub]--; if (cart[b.dataset.csub] <= 0) delete cart[b.dataset.csub]; renderMenu(); });
  $('cartTotal').textContent = ILS(cartTotal());
  const online = apiPayReady || !!(MENU.config && MENU.config.payUrl);
  $('payOnlineBtn').disabled = n === 0;
  $('payCounterBtn').disabled = n === 0;
  $('payOnlineBtn').style.display = online ? '' : 'none';
  $('checkoutNote').textContent = online
    ? 'תשלום מקוון בדף מאובטח (מינימום ' + MIN_ONLINE + ' ₪); בתשלום בקופה אין מינימום — ההזמנה נשלחת למטבח ומשלמים באיסוף.'
    : 'ההזמנה תישלח למטבח — התשלום בקופה בעת האיסוף.';
}

$('cartBar').onclick = () => $('cartSheet').classList.add('show');
$('cartClose').onclick = () => $('cartSheet').classList.remove('show');
$('cartSheet').onclick = e => { if (e.target === $('cartSheet')) $('cartSheet').classList.remove('show'); };

/* ---------- checkout ---------- */
function validContact() {
  const name = $('custName').value.trim();
  const email = $('custEmail').value.trim();
  if (!name) { alert('נא למלא שם מלא'); $('custName').focus(); return null; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { alert('נא למלא כתובת אימייל תקינה'); $('custEmail').focus(); return null; }
  return { name, email, phone: $('custPhone').value.trim() };
}

async function placeOrder(payMethod) {
  const items = cartItems().map(l => ({ name: l.it.name, qty: l.qty, price: l.it.price }));
  if (!items.length) return;
  if (payMethod === 'online' && cartTotal() < MIN_ONLINE) {
    alert('מינימום לקנייה באופן מקוון ' + MIN_ONLINE + ' שקלים');
    return;
  }
  const contact = validContact();
  if (!contact) return;
  const btn = payMethod === 'online' ? $('payOnlineBtn') : $('payCounterBtn');
  const label = btn.textContent;
  $('payOnlineBtn').disabled = $('payCounterBtn').disabled = true;
  btn.textContent = 'שולח הזמנה...';
  try {
    // text/plain keeps this a CORS "simple request" — Apps Script has no preflight handler
    const res = await fetch(api('action=neworder'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        items, total: cartTotal(), payMethod,
        name: contact.name, email: contact.email, phone: contact.phone
      })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'order failed');
    currentOrder = { order: j.order, total: cartTotal(), ...contact };
    $('cartSheet').classList.remove('show');
    if (payMethod === 'online') openPaymentSmart(); else showConfirm(false);
  } catch (e) {
    alert('שליחת ההזמנה נכשלה — נסו שוב');
  }
  $('payOnlineBtn').disabled = $('payCounterBtn').disabled = false;
  btn.textContent = label;
}
$('payOnlineBtn').onclick = () => placeOrder('online');
$('payCounterBtn').onclick = () => placeOrder('counter');

/* ---------- online payment (Morning) ----------
   MENU.config.payUrl is the business's Morning payment link, e.g.
   https://mrng.to/XXXXXXXX — set in the admin's digital-menu screen.

   MENU.config.payParams is the query template appended to it, so the
   parameter names can be corrected without touching code. Placeholders:
     {total} {order} {name} {email} {phone}
   Default: amount={total}&description=הזמנה {order}&name={name}&phone={phone}

   NOTE: a short link may drop query parameters on redirect, and Morning may
   name its fields differently. Whatever it does not accept, the customer
   simply types on the payment page — the order itself is already recorded.
   To make prefilling exact, replace payUrl with the long-form payment URL
   from Morning and adjust payParams to match its field names.

   API upgrade path: if you move to Morning's API, create the payment request
   inside the Apps Script (credentials stay server-side) and return its URL,
   then use that URL here instead of building one. */
const MIN_ONLINE = 30;   // minimum cart total for online payment (counter has no minimum)
const DEFAULT_PAY_PARAMS = 'amount={total}&description=הזמנה {order}&name={name}&email={email}&phone={phone}';
function payUrlFor(order) {
  const base = MENU.config.payUrl;
  const tpl = (MENU.config.payParams != null ? MENU.config.payParams : DEFAULT_PAY_PARAMS).trim();
  if (!tpl) return base;
  const vals = {
    total: order.total, order: order.order,
    name: order.name || '', email: order.email || '', phone: order.phone || ''
  };
  // build the query pair by pair and encode each value, so literal Hebrew in the
  // template (e.g. description=הזמנה {order}) always produces a well-formed URL
  const q = tpl.split('&').map(pair => {
    const i = pair.indexOf('=');
    if (i < 0) return encodeURIComponent(pair);
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).replace(/\{(\w+)\}/g, (m, key) => (key in vals ? vals[key] : m));
    return encodeURIComponent(k) + '=' + encodeURIComponent(v);
  }).join('&');
  return base + (base.includes('?') ? '&' : '?') + q;
}

/* Ask the backend for a hosted payment page created through the provider API
   (amount and customer already attached). Falls back to the configured static
   link when the API is not set up, so checkout never breaks. */
async function openPaymentSmart() {
  $('payOrderNo').textContent = '#' + currentOrder.order;
  $('payAmount').textContent = ILS(currentOrder.total);
  $('payHint').textContent = 'מכין דף תשלום…';
  $('payWrap').classList.add('show');
  $('payFrame').src = 'about:blank';
  try {
    const res = await fetch(api('action=paylink'), {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ order: currentOrder.order, back: location.href.split('?')[0] + location.search })
    });
    const j = await res.json();
    if (j.ok && j.url) { currentOrder.payUrl = j.url; openPayment(true); return; }
    console.warn('paylink unavailable:', j.error);
  } catch (e) { console.warn('paylink failed:', e.message); }
  openPayment(false);   // static link + copy-amount aid
}

function openPayment(fromApi) {
  $('payOrderNo').textContent = '#' + currentOrder.order;
  $('payAmount').textContent = ILS(currentOrder.total);
  if (fromApi) {
    // the provider page already carries the amount and the customer details
    $('payHint').innerHTML = `לתשלום ${ILS(currentOrder.total)} · הזמנה ${currentOrder.order}` +
      `<br><span style="opacity:.7">הפרטים מולאו מראש; האישור יתקבל אוטומטית</span>`;
    $('payFrame').src = currentOrder.payUrl;
    $('payWrap').classList.add('show');
    pollStatus();
    return;
  }
  $('payHint').innerHTML =
    `אם דף התשלום לא מילא את הפרטים — הזינו סכום <b>${currentOrder.total}</b> ₪` +
    ` <button id="payCopy" style="border:1.5px solid var(--line);background:var(--white);border-radius:8px;padding:2px 8px;font-size:12px;font-weight:800">העתק סכום</button>` +
    `<br>אסמכתה: הזמנה ${currentOrder.order} · ${esc(currentOrder.name || '')}`;
  const copy = $('payCopy');
  if (copy) copy.onclick = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(String(currentOrder.total))
      .then(() => { copy.textContent = 'הועתק ✓'; }).catch(() => {});
  };
  $('payFrame').src = payUrlFor(currentOrder);
  $('payWrap').classList.add('show');
  pollStatus();   // if the provider ever confirms server-side, the screen advances by itself
}
$('payExternal').onclick = () => { window.open(currentOrder.payUrl || payUrlFor(currentOrder), '_blank', 'noopener'); };
/* the customer tells us they paid; the order moves to preparation and the
   cashier sees it as paid (amount is verifiable in the Morning dashboard) */
$('payDone').onclick = async () => {
  const b = $('payDone');
  b.disabled = true; b.textContent = 'מאשר...';
  try {
    await fetch(api('action=confirmpaid'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ order: currentOrder.order })
    });
  } catch (e) { /* the order exists either way; the cashier can confirm manually */ }
  b.disabled = false; b.textContent = '✓ סיימתי לשלם';
  paymentDone();
};
$('payClose').onclick = () => {
  clearTimeout(statusTimer);
  $('payWrap').classList.remove('show');
  $('payFrame').src = 'about:blank';
};

/* poll the backend until the Grow webhook marks the order paid */
async function pollStatus() {
  clearTimeout(statusTimer);
  try {
    const res = await fetch(api('action=orderstatus&order=' + encodeURIComponent(currentOrder.order)));
    const j = await res.json();
    if (j.ok && j.paid) { paymentDone(); return; }
  } catch (e) { /* keep polling */ }
  statusTimer = setTimeout(pollStatus, 3000);
}
function paymentDone() {
  clearTimeout(statusTimer);
  $('payWrap').classList.remove('show');
  $('payFrame').src = 'about:blank';
  showConfirm(true);
}

/* ---------- confirmation ---------- */
function showConfirm(paid) {
  $('confirmTitle').textContent = paid ? 'תודה! ההזמנה נקלטה' : 'ההזמנה התקבלה!';
  $('confirmNum').textContent = '#' + currentOrder.order;
  $('confirmMsg').textContent = paid
    ? 'ההזמנה תיכנס להכנה מיד עם אישור התשלום. שמרו את מספר ההזמנה.'
    : 'ההזמנה ממתינה לתשלום — גשו לקופה, אמרו את מספר ההזמנה, וההכנה תתחיל.';
  $('confirm').classList.add('show');
  cart = {}; renderMenu();
}
$('newOrderBtn').onclick = () => { $('confirm').classList.remove('show'); currentOrder = null; };

/* the payment page sends the customer back here with ?paid=1&order=N */
(function handlePaymentReturn() {
  const q = new URLSearchParams(location.search);
  if (q.get('paid') === '1') {
    currentOrder = { order: q.get('order') || '', total: 0 };
    showConfirm(true);
  }
})();

loadMenu();
