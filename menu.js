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
    // Apps Script served HTML: a Google sign-in/consent page or an error page.
    const login = /accounts\.google\.com|ServiceLogin|Sign in|התחברות/i.test(txt);
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
  $('checkoutBtn').disabled = n === 0;
  $('checkoutNote').textContent = (MENU.config && MENU.config.payUrl)
    ? 'התשלום מתבצע באפליקציה, בדף מאובטח של Grow.'
    : 'ההזמנה תישלח למטבח — התשלום בקופה בעת האיסוף.';
}

$('cartBar').onclick = () => $('cartSheet').classList.add('show');
$('cartClose').onclick = () => $('cartSheet').classList.remove('show');
$('cartSheet').onclick = e => { if (e.target === $('cartSheet')) $('cartSheet').classList.remove('show'); };

/* ---------- checkout ---------- */
$('checkoutBtn').onclick = async () => {
  const items = cartItems().map(l => ({ name: l.it.name, qty: l.qty, price: l.it.price }));
  if (!items.length) return;
  $('checkoutBtn').disabled = true;
  $('checkoutBtn').textContent = 'שולח הזמנה...';
  try {
    // text/plain keeps this a CORS "simple request" — Apps Script has no preflight handler
    const res = await fetch(api('action=neworder'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ items, total: cartTotal(), name: $('custName').value.trim(), phone: $('custPhone').value.trim() })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'order failed');
    currentOrder = { order: j.order, total: cartTotal() };
    $('cartSheet').classList.remove('show');
    if (MENU.config && MENU.config.payUrl) openPayment();
    else showConfirm(false);
  } catch (e) {
    alert('שליחת ההזמנה נכשלה — נסו שוב');
  }
  $('checkoutBtn').disabled = false;
  $('checkoutBtn').textContent = 'להזמנה ולתשלום';
};

/* ---------- Grow in-app payment ----------
   MENU.config.payUrl is the business's Grow payment-page URL, set in the
   admin's digital-menu screen. We pass:
     sum     = order total   (Grow payment pages accept a preset amount)
     cField1 = order number  (comes back in the webhook so the backend can
                              mark the order paid automatically)
   If your Grow page uses different parameter names, change them here.
   If you later move to Grow's createPaymentProcess API, do the API call
   inside the Apps Script (keeping credentials server-side) and put the
   returned payment URL into `u` below. */
function payUrlFor(order) {
  const base = MENU.config.payUrl;
  const u = base + (base.includes('?') ? '&' : '?') +
    'sum=' + encodeURIComponent(order.total) +
    '&cField1=' + encodeURIComponent(order.order);
  return u;
}
function openPayment() {
  $('payOrderNo').textContent = '#' + currentOrder.order;
  $('payAmount').textContent = ILS(currentOrder.total);
  $('payFrame').src = payUrlFor(currentOrder);
  $('payWrap').classList.add('show');
  pollStatus();
}
$('payExternal').onclick = () => { window.open(payUrlFor(currentOrder), '_blank'); };
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
  $('confirmTitle').textContent = paid ? 'התשלום אושר — ההזמנה בהכנה!' : 'ההזמנה התקבלה!';
  $('confirmNum').textContent = '#' + currentOrder.order;
  $('confirmMsg').textContent = paid
    ? 'שמרו את מספר ההזמנה — נקרא לכם כשהיא מוכנה.'
    : 'גשו לקופה לתשלום ואמרו את מספר ההזמנה.';
  $('confirm').classList.add('show');
  cart = {}; renderMenu();
}
$('newOrderBtn').onclick = () => { $('confirm').classList.remove('show'); currentOrder = null; };

loadMenu();
