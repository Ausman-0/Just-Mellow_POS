import {
  PAYMENT_METHODS, parseMoneyToSatang, formatMoney, toDateKey, makeDateRange,
  filterSalesByRange, summarizeSales, buildCsv, validateProductInput, normalizeBackup
} from './domain.js';
import {
  openDB, getAll, getSetting, setSetting, saveProduct, deleteProduct, saveSale,
  updateSale, getBackupPayload, replaceLocalData
} from './db.js';
import {
  readSession, signInWithPassword, signUp, logout, getValidSession,
  fetchCloudBackup, uploadCloudBackup
} from './cloud.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const state = {
  page: 'pos',
  cart: new Map(),
  activeCategory: 'ทั้งหมด',
  products: [],
  sales: [],
  reportRange: makeDateRange('today'),
  installPrompt: null,
  cloudReady: false,
  pendingCloudBackup: null,
  cloudTimer: null,
  syncInProgress: false,
  resolvingCloudConflict: false
};

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `jm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function dateLabel(dateLike, withTime = false) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return 'ไม่ระบุเวลา';
  const opts = withTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('th-TH', opts).format(date);
}
function setBusy(button, busy, label = 'กำลังดำเนินการ...') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    delete button.dataset.originalText;
  }
}
function toast(message, type = 'success', ms = 3200) {
  const region = $('#toast-region');
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`;
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), ms);
}
function showError(error, context = '') {
  console.error(context || 'JUST MELLOW POS', error);
  const message = error?.message || String(error || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ');
  toast(context ? `${context}: ${message}` : message, 'error', 5000);
}
let activeModalKeyHandler = null;
function showModal(title, bodyHtml, footerHtml = '', { large = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal-card ${large ? 'modal-large' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header class="modal-heading"><h2>${escapeHtml(title)}</h2><button type="button" class="modal-close" id="modal-close" aria-label="ปิด">×</button></header><div class="modal-body">${bodyHtml}</div>${footerHtml ? `<footer class="modal-footer">${footerHtml}</footer>` : ''}</section></div>`;
  const backdrop = $('.modal-backdrop', root);
  $('#modal-close', root)?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(); });
  if (activeModalKeyHandler) document.removeEventListener('keydown', activeModalKeyHandler);
  activeModalKeyHandler = (event) => { if (event.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', activeModalKeyHandler);
  $('#modal-close', root)?.focus();
  return root;
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  if (activeModalKeyHandler) document.removeEventListener('keydown', activeModalKeyHandler);
  activeModalKeyHandler = null;
}
function confirmModal(title, message, confirmLabel = 'ยืนยัน', danger = false) {
  return new Promise((resolve) => {
    const root = showModal(title, `<p class="body-copy" style="margin:0;color:var(--ink)">${escapeHtml(message)}</p>`, `<button type="button" class="secondary-button" id="modal-cancel">กลับ</button><button type="button" class="${danger ? 'danger-button' : 'primary-button'}" id="modal-confirm">${escapeHtml(confirmLabel)}</button>`);
    $('#modal-cancel', root).addEventListener('click', () => { closeModal(); resolve(false); });
    $('#modal-confirm', root).addEventListener('click', () => { closeModal(); resolve(true); });
  });
}
function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}
function filenameDate(date = new Date()) { return toDateKey(date).replaceAll('-', ''); }
function todayKey() { return toDateKey(new Date()); }
function getLocalDateInputValue(date = new Date()) { return toDateKey(date); }
function moneyInputValue(satang) { return satang === null || satang === undefined ? '' : (Number(satang) / 100).toFixed(2); }

async function refreshData() {
  const [products, sales] = await Promise.all([getAll('products'), getAll('sales')]);
  state.products = products.sort((a, b) => a.category.localeCompare(b.category, 'th') || a.name.localeCompare(b.name, 'th'));
  state.sales = sales.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function markLocalChange() {
  const previous = Number(await getSetting('localRevision', 0));
  await setSetting('localRevision', Math.max(Date.now(), previous + 1));
  scheduleCloudBackup();
}
async function scheduleCloudBackup() {
  if (state.cloudTimer) clearTimeout(state.cloudTimer);
  if (!state.cloudReady || !navigator.onLine || !readSession()) {
    updateCloudStatusLine();
    return;
  }
  state.cloudTimer = setTimeout(() => runCloudUpload({ quiet: true }).catch((error) => {
    console.warn('Automatic cloud backup failed:', error);
    setCloudMessage(`สำรองข้อมูลไม่สำเร็จ: ${error.message}`, 'error');
    updateCloudStatusLine();
  }), 900);
  updateCloudStatusLine();
}
async function currentCloudConfig() { return await getSetting('supabaseConfig', { url: '', key: '' }); }
async function updateCloudUi() {
  const config = await currentCloudConfig();
  const session = readSession();
  $('#supabase-url').value = config.url || '';
  $('#supabase-key').value = config.key || '';
  $('#cloud-login').hidden = !!session;
  $('#cloud-signup').hidden = !!session;
  $('#cloud-logout').hidden = !session;
  $('#cloud-email').disabled = !!session;
  $('#cloud-password').disabled = !!session;
  $('#cloud-email').value = session?.user?.email || '';
  if (session) $('#cloud-password').value = '';
  $('#cloud-sync-actions').hidden = !session;
  $('#cloud-state-label').textContent = !config.url || !config.key ? 'ยังไม่ตั้งค่า' : session ? 'เข้าสู่ระบบแล้ว' : 'พร้อมเชื่อมต่อ';
  const lastTime = await getSetting('lastCloudSyncTime', null);
  $('#sync-meta').textContent = `${session?.user?.email || ''}\n${lastTime ? `สำรองสำเร็จล่าสุด ${dateLabel(lastTime, true)}` : 'ยังไม่มีประวัติสำรองสำเร็จ'}${navigator.onLine ? '' : '\nขณะนี้ออฟไลน์'}`;
  updateCloudStatusLine();
}
function setCloudMessage(message, type = '') {
  const el = $('#cloud-message');
  el.textContent = message || '';
  el.className = `cloud-message${type ? ` ${type}` : ''}`;
}
function updateCloudStatusLine() {
  const pill = $('#network-status');
  if (!pill) return;
  const online = navigator.onLine;
  pill.classList.toggle('online', online);
  pill.classList.toggle('offline', !online);
  pill.innerHTML = `<i></i><span>${online ? 'ออนไลน์' : 'ออฟไลน์'}</span>`;
  const about = $('#online-about');
  if (about) about.textContent = online ? 'ออนไลน์' : 'ออฟไลน์ · ขายต่อได้';
  updateStorageStats().catch(() => {});
}
async function updateStorageStats() {
  const products = await getAll('products');
  const sales = await getAll('sales');
  const last = await getSetting('lastCloudSyncTime', null);
  const root = $('#storage-stats');
  if (!root) return;
  root.innerHTML = `<div class="storage-stat"><span>เมนูทั้งหมด</span><strong>${products.length}</strong></div><div class="storage-stat"><span>บิลในเครื่อง</span><strong>${sales.length}</strong></div><div class="storage-stat"><span>สำรองออนไลน์</span><strong style="font-size:${last ? '11px' : '14px'}">${last ? escapeHtml(dateLabel(last)) : 'ยังไม่มี'}</strong></div>`;
}

function activatePage(page) {
  if (!$(`#page-${page}`)) return;
  state.page = page;
  $$('.page').forEach((node) => node.classList.toggle('active', node.dataset.page === page));
  $$('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.target === page));
  if (page === 'pos') renderPos();
  if (page === 'history') renderHistory();
  if (page === 'reports') renderReports();
  if (page === 'products') renderProducts();
  if (page === 'settings') { updateStorageStats(); updateCloudUi(); }
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function renderPos() {
  const search = ($('#pos-search')?.value || '').trim().toLocaleLowerCase('th');
  const activeProducts = state.products.filter((p) => p.active && !p.draft);
  const categories = ['ทั้งหมด', ...new Set(activeProducts.map((p) => p.category))];
  if (!categories.includes(state.activeCategory)) state.activeCategory = 'ทั้งหมด';
  $('#pos-categories').innerHTML = categories.map((cat) => `<button class="category-tab ${state.activeCategory === cat ? 'selected' : ''}" data-category="${escapeHtml(cat)}" type="button">${escapeHtml(cat)}</button>`).join('');
  const filtered = activeProducts.filter((product) => (state.activeCategory === 'ทั้งหมด' || product.category === state.activeCategory) && `${product.name} ${product.category}`.toLocaleLowerCase('th').includes(search));
  $('#pos-product-grid').innerHTML = filtered.length ? filtered.map((product) => `<button type="button" class="product-tile" data-add-product="${escapeHtml(product.id)}"><span class="tile-category">${escapeHtml(product.category)}</span><span class="tile-name">${escapeHtml(product.name)}</span><span class="tile-bottom"><strong class="tile-price">${formatMoney(product.priceSatang)}</strong><span class="tile-plus">+</span></span></button>`).join('') : `<div class="empty-state">${search ? 'ไม่พบเมนูที่ค้นหา' : 'ยังไม่มีสินค้าที่เปิดขาย ไปที่ “สินค้า” เพื่อเพิ่มหรือเปิดเมนู'}</div>`;
  renderCart();
  $('#today-chip').textContent = dateLabel(new Date());
}
function renderCart() {
  const list = [...state.cart.values()];
  const root = $('#cart-items');
  if (!list.length) {
    root.innerHTML = '<div class="cart-empty"><span class="empty-basket">＋</span><strong>ยังไม่มีสินค้า</strong><span>เลือกเมนูเพื่อเริ่มขาย</span></div>';
  } else {
    root.innerHTML = list.map((item) => `<div class="cart-item"><div><div class="cart-item-name">${escapeHtml(item.name)}</div><div class="cart-item-sub">${formatMoney(item.priceSatang)} / หน่วย</div><div class="quantity-control"><button type="button" class="qty-button" data-cart-decrease="${escapeHtml(item.id)}" aria-label="ลดจำนวน">−</button><span class="qty-number">${item.quantity}</span><button type="button" class="qty-button" data-cart-increase="${escapeHtml(item.id)}" aria-label="เพิ่มจำนวน">+</button><button type="button" class="remove-button" data-cart-remove="${escapeHtml(item.id)}" aria-label="ลบสินค้า">×</button></div></div><div class="cart-item-right"><strong class="cart-line-total">${formatMoney(item.priceSatang * item.quantity)}</strong></div></div>`).join('');
  }
  const count = list.reduce((sum, item) => sum + item.quantity, 0);
  const total = list.reduce((sum, item) => sum + item.priceSatang * item.quantity, 0);
  $('#cart-count').textContent = count;
  $('#cart-total').textContent = formatMoney(total);
  $('#checkout-button').disabled = !list.length;
}
function addToCart(id) {
  const product = state.products.find((p) => p.id === id && p.active && !p.draft);
  if (!product) return toast('สินค้านี้ไม่ได้เปิดขายอยู่', 'warning');
  const existing = state.cart.get(id);
  if (existing) existing.quantity += 1;
  else state.cart.set(id, { id: product.id, name: product.name, category: product.category, priceSatang: product.priceSatang, costSatang: product.costSatang, quantity: 1 });
  renderCart();
}
function changeCart(id, amount) {
  const item = state.cart.get(id);
  if (!item) return;
  item.quantity += amount;
  if (item.quantity <= 0) state.cart.delete(id);
  renderCart();
}
function nextReceiptNo(sales) {
  const prefix = `JM-${filenameDate()}-`;
  const sequence = sales.reduce((max, sale) => {
    if (!String(sale.receiptNo || '').startsWith(prefix)) return max;
    const suffix = Number(String(sale.receiptNo).slice(prefix.length));
    return Number.isFinite(suffix) ? Math.max(max, suffix) : max;
  }, 0) + 1;
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}
function getCurrentCartTotal() { return [...state.cart.values()].reduce((sum, item) => sum + item.priceSatang * item.quantity, 0); }

function openCheckout() {
  if (!state.cart.size) return;
  let selectedMethod = 'cash';
  const cartSnapshot = [...state.cart.values()].map((item) => ({ ...item }));
  const total = cartSnapshot.reduce((sum, item) => sum + item.priceSatang * item.quantity, 0);
  const body = `<div class="modal-form"><div class="modal-total"><span>ยอดที่ต้องชำระ</span><strong id="checkout-total">${formatMoney(total)}</strong></div><div><p class="field-label" style="font-size:11px;color:var(--muted);font-weight:700;margin:0 0 8px">เลือกวิธีชำระเงิน</p><div class="payment-choices"><button type="button" class="payment-choice selected" data-payment="cash"><span class="pay-symbol">฿</span><span>เงินสด</span></button><button type="button" class="payment-choice" data-payment="qr"><span class="pay-symbol">▦</span><span>QR Code</span></button><button type="button" class="payment-choice" data-payment="transfer"><span class="pay-symbol">⇄</span><span>โอนเงิน</span></button></div></div><div id="cash-fields" class="form-stack"><label class="field"><span>รับเงินมา (ไม่กรอก = รับพอดี)</span><input id="cash-received" type="number" min="0" step="0.01" placeholder="${(total / 100).toFixed(2)}" inputmode="decimal"></label><div class="modal-total"><span>เงินทอน</span><strong id="cash-change">${formatMoney(0)}</strong></div></div><p class="modal-help">ระบบนี้บันทึกวิธีชำระเงินเท่านั้น ไม่ได้ตรวจสอบการรับเงินจริง</p></div>`;
  const root = showModal('ยืนยันการขาย', body, '<button type="button" class="secondary-button" id="checkout-back">กลับไปแก้รายการ</button><button type="button" class="primary-button" id="confirm-sale">บันทึกบิล ✓</button>');
  const updateCash = () => {
    const receivedText = $('#cash-received', root).value.trim();
    const received = receivedText === '' ? total : parseMoneyToSatang(receivedText);
    const valid = received !== null && received >= total;
    $('#cash-change', root).textContent = valid ? formatMoney(received - total) : 'จำนวนเงินไม่พอ';
    $('#cash-change', root).style.color = valid ? 'var(--green)' : 'var(--danger)';
    $('#confirm-sale', root).disabled = selectedMethod === 'cash' && !valid;
  };
  $$('.payment-choice', root).forEach((button) => button.addEventListener('click', () => {
    selectedMethod = button.dataset.payment;
    $$('.payment-choice', root).forEach((node) => node.classList.toggle('selected', node === button));
    $('#cash-fields', root).hidden = selectedMethod !== 'cash';
    $('#confirm-sale', root).disabled = false;
    if (selectedMethod === 'cash') updateCash();
  }));
  $('#cash-received', root).addEventListener('input', updateCash);
  $('#checkout-back', root).addEventListener('click', closeModal);
  $('#confirm-sale', root).addEventListener('click', async () => {
    const button = $('#confirm-sale', root);
    setBusy(button, true, 'กำลังบันทึก...');
    try {
      // Verify the selected items remain sellable, but preserve the prices displayed in the cart.
      // If another tab changes a price during checkout, silently charging a different amount would be worse.
      const currentProducts = new Map((await getAll('products')).map((p) => [p.id, p]));
      const currentItems = [];
      for (const item of cartSnapshot) {
        const product = currentProducts.get(item.id);
        if (!product || !product.active || product.draft) throw new Error(`เมนู “${item.name}” ถูกปิดขายแล้ว กรุณาตรวจสอบรายการ`);
        if (!Number.isInteger(item.priceSatang) || item.priceSatang <= 0) throw new Error(`ราคาเมนู “${item.name}” ไม่ถูกต้อง`);
        currentItems.push({ productId: item.id, name: item.name, category: item.category, quantity: item.quantity, unitPriceSatang: item.priceSatang, unitCostSatang: product.costSatang === undefined ? (item.costSatang ?? null) : product.costSatang, lineTotalSatang: item.priceSatang * item.quantity });
      }
      const saleTotal = currentItems.reduce((sum, item) => sum + item.lineTotalSatang, 0);
      const receivedText = selectedMethod === 'cash' ? $('#cash-received', root).value.trim() : '';
      const receivedSatang = selectedMethod === 'cash' ? (receivedText === '' ? saleTotal : parseMoneyToSatang(receivedText)) : null;
      if (selectedMethod === 'cash' && (receivedSatang === null || receivedSatang < saleTotal)) throw new Error('จำนวนเงินที่รับต้องไม่น้อยกว่ายอดรวม');
      const allSales = await getAll('sales');
      const createdAt = new Date().toISOString();
      const sale = {
        id: uuid(), receiptNo: nextReceiptNo(allSales), createdAt, status: 'completed', cancelledAt: null, cancelReason: '',
        paymentMethod: selectedMethod, items: currentItems, itemCount: currentItems.reduce((sum, item) => sum + item.quantity, 0),
        subtotalSatang: saleTotal, totalSatang: saleTotal, receivedSatang, changeSatang: receivedSatang === null ? null : receivedSatang - saleTotal
      };
      await saveSale(sale);
      await markLocalChange();
      state.cart.clear();
      closeModal();
      await reloadAndRender();
      toast(`บันทึกบิล ${sale.receiptNo} สำเร็จ`);
      openSaleDetails(sale.id);
    } catch (error) {
      setBusy(button, false);
      showError(error, 'บันทึกบิลไม่สำเร็จ');
    }
  });
  updateCash();
}

function getRangeSales() { return filterSalesByRange(state.sales, state.reportRange.from, state.reportRange.to); }
function renderHistory() {
  const search = ($('#history-search')?.value || '').trim().toLocaleLowerCase('th');
  const from = $('#history-from')?.value || '';
  const to = $('#history-to')?.value || '';
  let sales = filterSalesByRange(state.sales, from, to);
  if (search) sales = sales.filter((sale) => `${sale.receiptNo} ${(sale.items || []).map((item) => item.name).join(' ')}`.toLocaleLowerCase('th').includes(search));
  $('#history-count').textContent = `${sales.length} บิล`;
  if (!sales.length) {
    $('#history-list').innerHTML = '<div class="blank-state"><strong>ยังไม่พบรายการขาย</strong><div style="font-size:11px;margin-top:5px">ลองเปลี่ยนช่วงวันที่หรือค้นหาด้วยคำอื่น</div></div>';
    return;
  }
  $('#history-list').innerHTML = sales.map((sale) => {
    const items = (sale.items || []).map((i) => `${i.name} × ${i.quantity}`).join(', ');
    const isCancelled = sale.status === 'cancelled';
    return `<article class="sale-card"><div><div class="sale-card-title"><strong>${escapeHtml(sale.receiptNo)}</strong><span class="status-tag ${isCancelled ? 'cancelled' : 'completed'}">${isCancelled ? 'ยกเลิกแล้ว' : 'สำเร็จ'}</span></div><div class="sale-card-desc">${escapeHtml(dateLabel(sale.createdAt, true))} · ${escapeHtml(PAYMENT_METHODS[sale.paymentMethod] || sale.paymentMethod)} · ${escapeHtml(items)}</div>${isCancelled ? `<div class="sale-card-desc" style="color:var(--danger)">เหตุผล: ${escapeHtml(sale.cancelReason || 'ไม่ระบุ')}</div>` : ''}</div><div class="sale-card-right"><div class="sale-card-amount">${formatMoney(sale.totalSatang)}</div><div class="sale-card-actions"><button type="button" class="mini-button" data-view-sale="${escapeHtml(sale.id)}">ดูบิล</button>${!isCancelled ? `<button type="button" class="mini-button danger" data-cancel-sale="${escapeHtml(sale.id)}">ยกเลิก</button>` : ''}</div></div></article>`;
  }).join('');
}
function openSaleDetails(saleId) {
  const sale = state.sales.find((s) => s.id === saleId) || null;
  if (!sale) return toast('ไม่พบบิลนี้ในข้อมูลปัจจุบัน', 'warning');
  const itemsHtml = sale.items.map((item) => `<div class="modal-line"><span>${escapeHtml(item.name)} × ${item.quantity}<br><small>${formatMoney(item.unitPriceSatang)} / หน่วย</small></span><strong>${formatMoney(item.lineTotalSatang)}</strong></div>`).join('');
  const footer = `${sale.status !== 'cancelled' ? `<button type="button" class="danger-button" id="details-cancel-sale">ยกเลิกบิล</button>` : ''}<button type="button" class="primary-button" id="details-close">ปิด</button>`;
  const root = showModal(`บิล ${sale.receiptNo}`, `<div class="modal-form"><div class="sale-card-title"><span class="status-tag ${sale.status === 'cancelled' ? 'cancelled' : 'completed'}">${sale.status === 'cancelled' ? 'ยกเลิกแล้ว' : 'สำเร็จ'}</span><span class="modal-help">${escapeHtml(dateLabel(sale.createdAt, true))}</span></div><div class="modal-line-items">${itemsHtml}</div><div class="profit-detail"><span>วิธีชำระเงิน</span><strong>${escapeHtml(PAYMENT_METHODS[sale.paymentMethod] || sale.paymentMethod)}</strong></div>${sale.paymentMethod === 'cash' ? `<div class="profit-detail"><span>รับเงิน / เงินทอน</span><strong>${formatMoney(sale.receivedSatang)} / ${formatMoney(sale.changeSatang)}</strong></div>` : ''}<div class="modal-total"><span>ยอดรวม</span><strong>${formatMoney(sale.totalSatang)}</strong></div>${sale.status === 'cancelled' ? `<p class="modal-help">ยกเลิกเมื่อ ${escapeHtml(dateLabel(sale.cancelledAt, true))} · เหตุผล: ${escapeHtml(sale.cancelReason || 'ไม่ระบุ')}</p>` : ''}</div>`, footer);
  $('#details-close', root).addEventListener('click', closeModal);
  $('#details-cancel-sale', root)?.addEventListener('click', () => { closeModal(); cancelSale(sale.id); });
}
async function cancelSale(saleId) {
  const sale = state.sales.find((s) => s.id === saleId);
  if (!sale || sale.status === 'cancelled') return;
  const root = showModal(`ยกเลิกบิล ${sale.receiptNo}`, `<form class="modal-form" id="cancel-sale-form"><p class="modal-help">บิลที่ยกเลิกจะยังอยู่ในประวัติ แต่ไม่นับในยอดขายสุทธิและกำไรขั้นต้น</p><label class="field"><span>เหตุผลการยกเลิก (จำเป็น)</span><textarea id="cancel-reason" rows="3" required maxlength="300" placeholder="เช่น ลูกค้าสั่งผิดรายการ"></textarea></label></form>`, '<button type="button" class="secondary-button" id="cancel-back">กลับ</button><button type="button" class="danger-button" id="confirm-cancel-sale">ยืนยันการยกเลิก</button>');
  $('#cancel-back', root).addEventListener('click', closeModal);
  $('#confirm-cancel-sale', root).addEventListener('click', async () => {
    const reason = $('#cancel-reason', root).value.trim();
    if (!reason) return toast('กรุณากรอกเหตุผลการยกเลิก', 'warning');
    const button = $('#confirm-cancel-sale', root);
    setBusy(button, true, 'กำลังยกเลิก...');
    try {
      const fresh = (await getAll('sales')).find((item) => item.id === saleId);
      if (!fresh || fresh.status === 'cancelled') throw new Error('บิลนี้ถูกยกเลิกไปแล้ว');
      fresh.status = 'cancelled'; fresh.cancelledAt = new Date().toISOString(); fresh.cancelReason = reason;
      await updateSale(fresh);
      await markLocalChange();
      closeModal();
      await reloadAndRender();
      toast(`ยกเลิกบิล ${fresh.receiptNo} แล้ว`);
    } catch (error) { setBusy(button, false); showError(error, 'ยกเลิกบิลไม่สำเร็จ'); }
  });
}

function renderReports() {
  const sales = getRangeSales();
  const summary = summarizeSales(sales, state.products);
  $('#report-date-note').textContent = `ช่วงรายงาน ${state.reportRange.from || 'ทั้งหมด'} ถึง ${state.reportRange.to || 'ปัจจุบัน'} · ใช้วันที่ขายในเวลาท้องถิ่น`;
  $('#report-kpis').innerHTML = [
    ['ยอดขายสุทธิ', formatMoney(summary.netSalesSatang), `${summary.completedBillCount} บิลที่ไม่ถูกยกเลิก`],
    ['บิลทั้งหมด', String(summary.issuedBillCount), `${summary.cancelledBillCount} บิลถูกยกเลิก`],
    ['จำนวนสินค้าที่ขาย', String(summary.itemCount), 'นับเฉพาะบิลที่ไม่ถูกยกเลิก'],
    ['ยอดก่อนหักบิลยกเลิก', formatMoney(summary.grossIssuedSatang), 'รวมยอดบิลทุกสถานะ']
  ].map(([label, value, note]) => `<article class="kpi-card"><span class="kpi-label">${label}</span><strong class="kpi-value">${value}</strong><span class="kpi-note">${note}</span></article>`).join('');
  const payEntries = Object.entries(PAYMENT_METHODS).map(([key, label]) => ({ key, label, amount: summary.paymentTotals[key] || 0 }));
  const paymentMax = Math.max(1, ...payEntries.map((entry) => entry.amount));
  $('#payment-breakdown').innerHTML = payEntries.map((entry) => `<div class="payment-row"><span class="payment-label">${entry.label}</span><div class="payment-track"><div class="payment-fill" style="width:${Math.max(0, entry.amount / paymentMax * 100)}%"></div></div><strong class="payment-amount">${formatMoney(entry.amount)}</strong></div>`).join('');
  $('#profit-summary').innerHTML = summary.costsComplete
    ? `<div class="profit-hero"><span class="label">กำไรขั้นต้นโดยประมาณ</span><strong>${formatMoney(summary.grossProfitSatang)}</strong><span class="label">อัตรากำไรขั้นต้น ${summary.grossMarginPercent === null ? '—' : `${summary.grossMarginPercent.toFixed(1)}%`}</span></div><div class="profit-detail"><span>ยอดขายสุทธิ</span><strong>${formatMoney(summary.netSalesSatang)}</strong></div><div class="profit-detail"><span>ต้นทุนสินค้าที่ขาย</span><strong>${formatMoney(summary.costSatang)}</strong></div><p class="small-note">คำนวณจากต้นทุนที่บันทึกในแต่ละบิล ไม่รวมค่าใช้จ่ายอื่นของร้าน</p>`
    : `<div class="profit-hero"><span class="label">กำไรขั้นต้น</span><strong style="font-size:19px">ยังคำนวณไม่ได้ครบ</strong><span class="label">กรอกต้นทุนให้ครบทุกสินค้าที่ขายในช่วงนี้</span></div><div class="profit-detail"><span>ยอดขายสุทธิ</span><strong>${formatMoney(summary.netSalesSatang)}</strong></div><div class="warning-copy">${summary.completedBillCount ? 'มีสินค้าอย่างน้อยหนึ่งรายการที่ยังไม่มีต้นทุน จึงไม่แสดงตัวเลขกำไรที่อาจทำให้เข้าใจผิด' : 'ยังไม่มีบิลที่เสร็จสมบูรณ์ในช่วงนี้'}</div>`;
  renderProductReportTable('#best-sellers', summary.bestSellers.slice(0, 8), true);
  renderProductReportTable('#slow-sellers', [...summary.slowSellers].slice(0, 8), false);
}
function renderProductReportTable(selector, rows, best) {
  const root = $(selector);
  if (!rows.length) { root.innerHTML = '<div class="blank-state" style="padding:25px">ยังไม่มีข้อมูลสินค้าในช่วงเวลานี้</div>'; return; }
  root.innerHTML = `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>สินค้า</th><th class="number">จำนวน</th><th class="number">ยอดขาย</th><th class="number">กำไรขั้นต้น</th></tr></thead><tbody>${rows.map((row, index) => `<tr><td>${best ? `<span class="rank-pill">${index + 1}</span>` : ''}${escapeHtml(row.name)}${row.missingCost ? '<br><small style="color:var(--amber)">ต้นทุนไม่ครบ</small>' : ''}</td><td class="number">${row.quantity}</td><td class="number">${formatMoney(row.salesSatang)}</td><td class="number">${row.grossProfitSatang === null ? '—' : formatMoney(row.grossProfitSatang)}</td></tr>`).join('')}</tbody></table></div>`;
}

function csvRowsFor(type, sales, summary) {
  const from = state.reportRange.from || 'ไม่ระบุ';
  const to = state.reportRange.to || 'ไม่ระบุ';
  const common = [['JUST MELLOW POS', 'รายงาน', type, 'ตั้งแต่', from, 'ถึง', to, 'สร้างเมื่อ', dateLabel(new Date(), true)]];
  if (type === 'summary') {
    return [...common, [], ['ตัวชี้วัด', 'ค่า'], ['ยอดขายก่อนหักบิลยกเลิก (บาท)', (summary.grossIssuedSatang / 100).toFixed(2)], ['ยอดขายสุทธิ (บาท)', (summary.netSalesSatang / 100).toFixed(2)], ['จำนวนบิลทั้งหมด', summary.issuedBillCount], ['บิลที่ไม่ถูกยกเลิก', summary.completedBillCount], ['บิลยกเลิก', summary.cancelledBillCount], ['จำนวนสินค้าที่ขาย', summary.itemCount], ['ต้นทุนสินค้าที่ขาย (บาท)', summary.costSatang === null ? 'ต้นทุนไม่ครบ' : (summary.costSatang / 100).toFixed(2)], ['กำไรขั้นต้น (บาท)', summary.grossProfitSatang === null ? 'ต้นทุนไม่ครบ' : (summary.grossProfitSatang / 100).toFixed(2)], ['อัตรากำไรขั้นต้น (%)', summary.grossMarginPercent === null ? 'ต้นทุนไม่ครบหรือยอดขายเป็นศูนย์' : summary.grossMarginPercent.toFixed(2)], [], ['วิธีชำระเงิน', 'ยอดขาย (บาท)'], ...Object.entries(PAYMENT_METHODS).map(([key, label]) => [label, (summary.paymentTotals[key] / 100).toFixed(2)])];
  }
  if (type === 'bills') {
    return [...common, [], ['หมายเลขบิล', 'วันเวลา', 'สถานะ', 'วิธีชำระ', 'จำนวนสินค้า', 'ยอดรวม (บาท)', 'รับเงิน (บาท)', 'เงินทอน (บาท)', 'วันเวลายกเลิก', 'เหตุผลยกเลิก'], ...sales.map((sale) => [sale.receiptNo, dateLabel(sale.createdAt, true), sale.status === 'cancelled' ? 'ยกเลิก' : 'สำเร็จ', PAYMENT_METHODS[sale.paymentMethod] || sale.paymentMethod, sale.itemCount, (sale.totalSatang / 100).toFixed(2), sale.receivedSatang === null ? '' : (sale.receivedSatang / 100).toFixed(2), sale.changeSatang === null ? '' : (sale.changeSatang / 100).toFixed(2), sale.cancelledAt ? dateLabel(sale.cancelledAt, true) : '', sale.cancelReason || ''])];
  }
  if (type === 'items') {
    return [...common, [], ['หมายเลขบิล', 'วันเวลา', 'สถานะบิล', 'วิธีชำระ', 'รหัสสินค้า', 'สินค้า', 'หมวดหมู่', 'จำนวน', 'ราคาต่อหน่วย (บาท)', 'ต้นทุนต่อหน่วย (บาท)', 'ยอดรายการ (บาท)', 'ต้นทุนรวม (บาท)', 'กำไรขั้นต้น (บาท)'], ...sales.flatMap((sale) => (sale.items || []).map((item) => [sale.receiptNo, dateLabel(sale.createdAt, true), sale.status === 'cancelled' ? 'ยกเลิก' : 'สำเร็จ', PAYMENT_METHODS[sale.paymentMethod] || sale.paymentMethod, item.productId, item.name, item.category, item.quantity, (item.unitPriceSatang / 100).toFixed(2), item.unitCostSatang === null || item.unitCostSatang === undefined ? 'ต้นทุนไม่ครบ' : (item.unitCostSatang / 100).toFixed(2), (item.lineTotalSatang / 100).toFixed(2), item.unitCostSatang === null || item.unitCostSatang === undefined ? 'ต้นทุนไม่ครบ' : ((item.unitCostSatang * item.quantity) / 100).toFixed(2), item.unitCostSatang === null || item.unitCostSatang === undefined ? 'ต้นทุนไม่ครบ' : (((item.unitPriceSatang - item.unitCostSatang) * item.quantity) / 100).toFixed(2)]))];
  }
  if (type === 'profit') {
    return [...common, [], ['หมายเลขบิล', 'สินค้า', 'สถานะบิล', 'จำนวน', 'ยอดขาย (บาท)', 'ต้นทุน (บาท)', 'กำไรขั้นต้น (บาท)'], ...sales.filter((sale) => sale.status !== 'cancelled').flatMap((sale) => (sale.items || []).map((item) => [sale.receiptNo, item.name, 'สำเร็จ', item.quantity, (item.lineTotalSatang / 100).toFixed(2), item.unitCostSatang === null || item.unitCostSatang === undefined ? 'ต้นทุนไม่ครบ' : ((item.unitCostSatang * item.quantity) / 100).toFixed(2), item.unitCostSatang === null || item.unitCostSatang === undefined ? 'ต้นทุนไม่ครบ' : (((item.unitPriceSatang - item.unitCostSatang) * item.quantity) / 100).toFixed(2)])), [], ['ยอดขายสุทธิ (บาท)', (summary.netSalesSatang / 100).toFixed(2)], ['ต้นทุนรวม (บาท)', summary.costSatang === null ? 'ต้นทุนไม่ครบ' : (summary.costSatang / 100).toFixed(2)], ['กำไรขั้นต้น (บาท)', summary.grossProfitSatang === null ? 'ต้นทุนไม่ครบ' : (summary.grossProfitSatang / 100).toFixed(2)], ['อัตรากำไรขั้นต้น (%)', summary.grossMarginPercent === null ? 'ต้นทุนไม่ครบหรือยอดขายเป็นศูนย์' : summary.grossMarginPercent.toFixed(2)]];
  }
  return [...common, [], ['อันดับ', 'สินค้า', 'หมวดหมู่', 'จำนวนที่ขาย', 'ยอดขาย (บาท)', 'ต้นทุน (บาท)', 'กำไรขั้นต้น (บาท)'], ...[...summary.bestSellers].map((row, index) => [index + 1, row.name, row.category, row.quantity, (row.salesSatang / 100).toFixed(2), row.missingCost ? 'ต้นทุนไม่ครบ' : (row.costSatang / 100).toFixed(2), row.grossProfitSatang === null ? 'ต้นทุนไม่ครบ' : (row.grossProfitSatang / 100).toFixed(2)])];
}
function exportReport() {
  const type = $('#export-type').value;
  const sales = getRangeSales();
  const summary = summarizeSales(sales, state.products);
  const csv = buildCsv(csvRowsFor(type, sales, summary));
  const names = { summary: 'sales-summary', bills: 'bill-details', items: 'sale-items', profit: 'cost-profit', products: 'product-performance' };
  downloadBlob(`JUST-MELLOW-${names[type] || 'report'}-${state.reportRange.from || 'all'}-${state.reportRange.to || 'all'}.csv`, csv, 'text/csv;charset=utf-8;');
  toast('ดาวน์โหลดรายงาน CSV แล้ว');
}

function renderProducts() {
  const products = [...state.products].sort((a, b) => a.category.localeCompare(b.category, 'th') || a.name.localeCompare(b.name, 'th'));
  if (!products.length) { $('#product-admin-list').innerHTML = '<div class="blank-state">ยังไม่มีสินค้า กด “เพิ่มสินค้า” เพื่อเริ่มต้น</div>'; return; }
  $('#product-admin-list').innerHTML = products.map((product) => `<article class="product-admin-row"><div class="product-admin-main"><div class="product-admin-name">${escapeHtml(product.name)}${product.draft ? '<span class="status-tag draft">เมนูทดลอง</span>' : ''}${!product.active ? '<span class="status-tag cancelled">ปิดขาย</span>' : ''}</div><div class="product-admin-meta">${escapeHtml(product.category)} · ต้นทุน ${product.costSatang === null || product.costSatang === undefined ? 'ยังไม่ระบุ' : formatMoney(product.costSatang)}</div></div><div class="product-admin-price"><strong>${formatMoney(product.priceSatang)}</strong><div class="product-admin-actions"><button type="button" class="mini-button" data-edit-product="${escapeHtml(product.id)}">แก้ไข</button><button type="button" class="mini-button" data-toggle-product="${escapeHtml(product.id)}">${product.active ? 'ปิดขาย' : 'เปิดขาย'}</button></div></div></article>`).join('');
}
function openProductEditor(productId = null) {
  const existing = productId ? state.products.find((p) => p.id === productId) : null;
  const root = showModal(existing ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า', `<form class="modal-form" id="product-form"><label class="field"><span>ชื่อสินค้า</span><input id="product-name" required maxlength="90" value="${escapeHtml(existing?.name || '')}" placeholder="เช่น พุดดิ้งนมสดคาราเมล"></label><label class="field"><span>หมวดหมู่</span><input id="product-category" required list="category-options" maxlength="50" value="${escapeHtml(existing?.category || '')}" placeholder="เช่น พุดดิ้ง"><datalist id="category-options">${[...new Set(state.products.map((p) => p.category))].map((cat) => `<option value="${escapeHtml(cat)}"></option>`).join('')}</datalist></label><div class="filter-row"><label class="field"><span>ราคาขาย (บาท)</span><input id="product-price" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${existing ? moneyInputValue(existing.priceSatang) : ''}" placeholder="30.00"></label><label class="field"><span>ต้นทุนต่อหน่วย (บาท)</span><input id="product-cost" type="number" inputmode="decimal" min="0" step="0.01" value="${existing?.costSatang === null || existing?.costSatang === undefined ? '' : moneyInputValue(existing.costSatang)}" placeholder="เว้นว่างได้"></label></div><label class="inline-check" style="display:flex;align-items:center;gap:9px;font-size:12px;color:var(--muted)"><input id="product-active" type="checkbox" ${existing ? (existing.active ? 'checked' : '') : 'checked'}> เปิดขายในหน้าร้าน</label><p class="modal-help">ราคาต้นทุนเว้นว่างได้ แต่ระบบจะไม่คำนวณกำไรสำหรับรายการที่ไม่มีข้อมูลต้นทุน</p></form>`, `<button type="button" class="secondary-button" id="product-cancel">ยกเลิก</button><button type="button" class="primary-button" id="save-product">บันทึกสินค้า</button>`);
  $('#product-cancel', root).addEventListener('click', closeModal);
  $('#product-form', root).addEventListener('submit', (event) => { event.preventDefault(); $('#save-product', root).click(); });
  $('#save-product', root).addEventListener('click', async () => {
    const button = $('#save-product', root);
    const validated = validateProductInput({ name: $('#product-name', root).value, category: $('#product-category', root).value, price: $('#product-price', root).value, cost: $('#product-cost', root).value });
    if (!validated.valid) return toast(validated.errors[0], 'warning');
    setBusy(button, true, 'กำลังบันทึก...');
    try {
      const now = new Date().toISOString();
      const product = {
        id: existing?.id || `prod-${uuid()}`,
        name: validated.value.name,
        category: validated.value.category,
        priceSatang: validated.value.priceSatang,
        costSatang: validated.value.costSatang,
        active: $('#product-active', root).checked,
        draft: existing?.draft || false,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      await saveProduct(product);
      await markLocalChange();
      closeModal();
      await reloadAndRender();
      toast(existing ? 'บันทึกการแก้ไขสินค้าแล้ว' : 'เพิ่มสินค้าแล้ว');
    } catch (error) { setBusy(button, false); showError(error, 'บันทึกสินค้าไม่สำเร็จ'); }
  });
}
async function toggleProduct(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  product.active = !product.active;
  product.updatedAt = new Date().toISOString();
  try {
    await saveProduct(product);
    await markLocalChange();
    await reloadAndRender();
    toast(product.active ? `เปิดขาย ${product.name} แล้ว` : `ปิดขาย ${product.name} แล้ว`);
  } catch (error) { showError(error, 'เปลี่ยนสถานะสินค้าไม่สำเร็จ'); }
}

async function exportBackup() {
  const payload = await getBackupPayload();
  downloadBlob(`JUST-MELLOW-backup-${filenameDate()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  toast('ดาวน์โหลดไฟล์สำรองแล้ว');
}
async function importBackupFile(file) {
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 30 MB กรุณาตรวจสอบไฟล์สำรอง');
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('ไฟล์นี้ไม่ใช่ JSON ที่ถูกต้อง'); }
  const backup = normalizeBackup(parsed);
  const ok = await confirmModal('นำเข้าข้อมูลสำรอง?', `ไฟล์นี้มีสินค้า ${backup.products.length} รายการ และบิล ${backup.sales.length} รายการ การนำเข้าจะแทนที่ข้อมูลสินค้าและบิลในเครื่องปัจจุบัน ควรดาวน์โหลดไฟล์สำรองชุดปัจจุบันก่อน`, 'แทนที่ข้อมูล', true);
  if (!ok) return;
  await replaceLocalData(backup);
  await markLocalChange();
  await reloadAndRender();
  toast('นำเข้าข้อมูลสำรองสำเร็จ');
}

async function saveCloudConfig(event) {
  event.preventDefault();
  const url = $('#supabase-url').value.trim().replace(/\/$/, '');
  const key = $('#supabase-key').value.trim();
  if (!url || !key) return setCloudMessage('กรุณากรอกทั้ง Project URL และ public anon/publishable key', 'error');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new Error('URL ต้องขึ้นต้นด้วย https://');
    if (key.toLowerCase().includes('service_role')) throw new Error('ห้ามใช้ service_role key ในแอปฝั่งผู้ใช้ ให้ใช้ anon/publishable key');
    await setSetting('supabaseConfig', { url, key });
    state.cloudReady = false;
    setCloudMessage('บันทึกการเชื่อมต่อแล้ว หากตั้งค่าตารางและ RLS ใน Supabase เรียบร้อย ให้เข้าสู่ระบบเพื่อเริ่มสำรองข้อมูล', 'success');
    await updateCloudUi();
    if (readSession() && navigator.onLine) await prepareCloudSession();
  } catch (error) { setCloudMessage(error.message, 'error'); }
}
async function cloudSignup() {
  const config = await currentCloudConfig();
  const email = $('#cloud-email').value.trim();
  const password = $('#cloud-password').value;
  if (!config.url || !config.key) return setCloudMessage('กรุณาบันทึก Supabase URL และ key ก่อนสมัคร', 'error');
  if (!email || password.length < 8) return setCloudMessage('กรอกอีเมลและรหัสผ่านอย่างน้อย 8 ตัวอักษร', 'error');
  const button = $('#cloud-signup'); setBusy(button, true, 'กำลังสมัคร...');
  try {
    const result = await signUp(config, email, password);
    if (result.session) {
      setCloudMessage('สมัครบัญชีสำเร็จ กำลังตรวจสอบข้อมูลสำรอง...', 'success');
      await updateCloudUi();
      await prepareCloudSession();
    } else {
      setCloudMessage('ส่งคำขอสมัครแล้ว หากโปรเจกต์เปิดยืนยันอีเมลไว้ ให้กดยืนยันจากอีเมลก่อน แล้วจึงเข้าสู่ระบบ', 'success');
    }
  } catch (error) { setCloudMessage(error.message, 'error'); }
  finally { setBusy(button, false); await updateCloudUi(); }
}
async function cloudLogin(event) {
  event.preventDefault();
  const config = await currentCloudConfig();
  const email = $('#cloud-email').value.trim();
  const password = $('#cloud-password').value;
  if (!config.url || !config.key) return setCloudMessage('กรุณาบันทึก Supabase URL และ key ก่อนเข้าสู่ระบบ', 'error');
  const button = $('#cloud-login'); setBusy(button, true, 'กำลังเข้าสู่ระบบ...');
  try {
    await signInWithPassword(config, email, password);
    state.cloudReady = false;
    setCloudMessage('เข้าสู่ระบบแล้ว กำลังตรวจสอบข้อมูลสำรอง...', 'success');
    await updateCloudUi();
    await prepareCloudSession();
  } catch (error) { setCloudMessage(error.message, 'error'); }
  finally { setBusy(button, false); await updateCloudUi(); }
}
async function cloudLogout() {
  const session = readSession();
  if (!session) return;
  const ok = await confirmModal('ออกจากระบบสำรองข้อมูล?', 'ข้อมูลในเครื่องจะยังใช้งานได้ แต่ระบบจะหยุดสำรองออนไลน์บนอุปกรณ์นี้', 'ออกจากระบบ');
  if (!ok) return;
  try { await logout(await currentCloudConfig(), session); } catch (error) { console.warn(error); }
  state.cloudReady = false;
  state.pendingCloudBackup = null;
  setCloudMessage('ออกจากระบบสำรองข้อมูลแล้ว ข้อมูลในเครื่องไม่ได้ถูกลบ', 'success');
  await updateCloudUi();
}
async function prepareCloudSession() {
  if (state.resolvingCloudConflict) return;
  const config = await currentCloudConfig();
  let session = readSession();
  if (!session || !config.url || !config.key) { state.cloudReady = false; await updateCloudUi(); return; }
  if (!navigator.onLine) { state.cloudReady = false; setCloudMessage('ขณะนี้ออฟไลน์ ระบบขายยังใช้งานได้ และจะตรวจสอบข้อมูลสำรองเมื่อกลับมาออนไลน์', 'warning'); return; }
  try {
    session = await getValidSession(config);
    const remote = await fetchCloudBackup(config, session);
    const linkedOwner = await getSetting('cloudLinkedOwner', null);
    const lastCloudUpdatedAt = await getSetting('lastCloudUpdatedAt', null);
    if (remote?.payload) {
      const timestampsMatch = lastCloudUpdatedAt && Date.parse(lastCloudUpdatedAt) === Date.parse(remote.updated_at);
      if (linkedOwner === session.user.id && timestampsMatch) {
        state.cloudReady = true;
        setCloudMessage('เชื่อมต่อข้อมูลสำรองออนไลน์แล้ว', 'success');
        await updateCloudUi();
        const revision = await getSetting('localRevision', 0);
        const syncedRevision = await getSetting('lastCloudSyncRevision', null);
        if (revision && String(revision) !== String(syncedRevision)) scheduleCloudBackup();
        return;
      }
      state.cloudReady = false;
      state.pendingCloudBackup = remote;
      openCloudConflict(remote);
      await updateCloudUi();
      return;
    }
    await setSetting('cloudLinkedOwner', session.user.id);
    state.cloudReady = true;
    setCloudMessage('ยังไม่มีข้อมูลสำรองออนไลน์ ระบบจะสร้างข้อมูลสำรองจากเครื่องนี้ให้', 'success');
    await updateCloudUi();
    await runCloudUpload({ quiet: false });
  } catch (error) {
    state.cloudReady = false;
    setCloudMessage(`เชื่อมต่อหรืออ่านข้อมูลสำรองไม่สำเร็จ: ${error.message}`, 'error');
    await updateCloudUi();
  }
}
function openCloudConflict(remote) {
  const created = remote.updated_at ? dateLabel(remote.updated_at, true) : 'ไม่ทราบเวลา';
  const payload = remote.payload || {};
  const body = `<p class="body-copy" style="margin:0 0 13px;color:var(--ink)">พบข้อมูลสำรองออนไลน์ของบัญชีนี้ อัปเดตล่าสุด ${escapeHtml(created)} มีสินค้า ${Array.isArray(payload.products) ? payload.products.length : 0} รายการ และบิล ${Array.isArray(payload.sales) ? payload.sales.length : 0} รายการ</p><div class="warning-copy">เพื่อป้องกันข้อมูลทับกัน ระบบจะไม่เลือกข้อมูลแทนคุณอัตโนมัติ โปรดตรวจสอบก่อนเลือกหนึ่งทาง</div><div class="conflict-choice" style="margin-top:13px"><button class="conflict-option" id="use-cloud-backup" type="button"><strong>ใช้ข้อมูลจากออนไลน์</strong><span>แทนที่สินค้าและบิลในเครื่องด้วยชุดสำรองนี้</span></button><button class="conflict-option" id="keep-local-backup" type="button"><strong>ใช้ข้อมูลในเครื่องนี้</strong><span>อัปโหลดข้อมูลในเครื่องเพื่อแทนที่ชุดสำรองออนไลน์</span></button></div>`;
  const root = showModal('เลือกข้อมูลที่จะใช้', body, '<button type="button" class="secondary-button" id="cloud-conflict-cancel">ตัดสินใจภายหลัง</button>');
  $('#cloud-conflict-cancel', root).addEventListener('click', () => { closeModal(); setCloudMessage('ยังไม่ได้เลือกชุดข้อมูล ระบบสำรองออนไลน์จะพักไว้จนกว่าจะเลือก', 'warning'); });
  $('#use-cloud-backup', root).addEventListener('click', async () => {
    state.resolvingCloudConflict = true;
    try {
      const normalized = normalizeBackup(remote.payload);
      await replaceLocalData(normalized);
      await setSetting('cloudLinkedOwner', readSession()?.user?.id || null);
      await setSetting('lastCloudUpdatedAt', remote.updated_at);
      const revision = await getSetting('localRevision', 0);
      await setSetting('lastCloudSyncRevision', revision);
      await setSetting('lastCloudSyncTime', remote.updated_at);
      state.cloudReady = true;
      closeModal();
      setCloudMessage('นำข้อมูลสำรองออนไลน์มาใช้ในเครื่องแล้ว', 'success');
      await reloadAndRender(); await updateCloudUi();
    } catch (error) { showError(error, 'กู้คืนจากข้อมูลออนไลน์ไม่สำเร็จ'); }
    finally { state.resolvingCloudConflict = false; }
  });
  $('#keep-local-backup', root).addEventListener('click', async () => {
    state.resolvingCloudConflict = true;
    try {
      const session = await getValidSession(await currentCloudConfig());
      await setSetting('cloudLinkedOwner', session.user.id);
      state.cloudReady = true;
      closeModal();
      await runCloudUpload({ quiet: false });
    } catch (error) { setCloudMessage(`สำรองข้อมูลในเครื่องไม่สำเร็จ: ${error.message}`, 'error'); showError(error, 'สำรองข้อมูลไม่สำเร็จ'); }
    finally { state.resolvingCloudConflict = false; }
  });
}
async function runCloudUpload({ quiet = false } = {}) {
  if (state.syncInProgress) return;
  const config = await currentCloudConfig();
  let session = readSession();
  if (!session || !config.url || !config.key) return;
  if (!navigator.onLine) { if (!quiet) setCloudMessage('ขณะนี้ออฟไลน์ ข้อมูลอยู่ในเครื่องและจะสำรองเมื่อกลับมาออนไลน์', 'warning'); return; }
  state.syncInProgress = true;
  const button = $('#manual-sync'); if (!quiet) setBusy(button, true, 'กำลังสำรอง...');
  try {
    session = await getValidSession(config);
    const payload = await getBackupPayload();
    const revision = await getSetting('localRevision', 0);
    const updatedAt = await uploadCloudBackup(config, session, payload);
    await setSetting('cloudLinkedOwner', session.user.id);
    await setSetting('lastCloudUpdatedAt', updatedAt);
    await setSetting('lastCloudSyncRevision', revision);
    await setSetting('lastCloudSyncTime', updatedAt);
    state.cloudReady = true;
    if (!quiet) setCloudMessage(`สำรองข้อมูลสำเร็จ ${dateLabel(updatedAt, true)}`, 'success');
    else setCloudMessage(`สำรองข้อมูลอัตโนมัติแล้ว ${dateLabel(updatedAt, true)}`, 'success');
    await updateCloudUi();
    const currentRevision = await getSetting('localRevision', 0);
    if (String(currentRevision) !== String(revision)) scheduleCloudBackup();
  } catch (error) {
    state.cloudReady = !!readSession();
    if (!quiet) setCloudMessage(`สำรองข้อมูลไม่สำเร็จ: ${error.message}`, 'error');
    throw error;
  } finally {
    state.syncInProgress = false;
    if (!quiet) setBusy(button, false);
  }
}
async function onNetworkOnline() {
  updateCloudStatusLine();
  if (readSession()) await prepareCloudSession();
}

async function reloadAndRender() {
  await refreshData();
  renderPos(); renderHistory(); renderReports(); renderProducts();
  await updateStorageStats();
}
function installEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => activatePage(button.dataset.target)));
  $('#pos-search').addEventListener('input', renderPos);
  $('#pos-categories').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]'); if (!button) return;
    state.activeCategory = button.dataset.category; renderPos();
  });
  $('#pos-product-grid').addEventListener('click', (event) => { const button = event.target.closest('[data-add-product]'); if (button) addToCart(button.dataset.addProduct); });
  $('#cart-items').addEventListener('click', (event) => {
    const increase = event.target.closest('[data-cart-increase]'); if (increase) return changeCart(increase.dataset.cartIncrease, 1);
    const decrease = event.target.closest('[data-cart-decrease]'); if (decrease) return changeCart(decrease.dataset.cartDecrease, -1);
    const remove = event.target.closest('[data-cart-remove]'); if (remove) { state.cart.delete(remove.dataset.cartRemove); renderCart(); }
  });
  $('#clear-cart').addEventListener('click', async () => {
    if (!state.cart.size) return;
    if (await confirmModal('ล้างรายการขาย?', 'สินค้าที่เลือกไว้ในบิลปัจจุบันจะถูกลบออก', 'ล้างรายการ', true)) { state.cart.clear(); renderCart(); }
  });
  $('#checkout-button').addEventListener('click', openCheckout);
  $('#history-search').addEventListener('input', renderHistory);
  $('#history-from').value = todayKey(); $('#history-to').value = todayKey();
  $('#history-from').addEventListener('change', renderHistory); $('#history-to').addEventListener('change', renderHistory);
  $('#history-reset').addEventListener('click', () => { $('#history-from').value = ''; $('#history-to').value = ''; $('#history-search').value = ''; renderHistory(); });
  $('#history-list').addEventListener('click', (event) => {
    const view = event.target.closest('[data-view-sale]'); if (view) return openSaleDetails(view.dataset.viewSale);
    const cancel = event.target.closest('[data-cancel-sale]'); if (cancel) cancelSale(cancel.dataset.cancelSale);
  });
  $('#report-presets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-range]'); if (!button) return;
    $$('#report-presets button').forEach((node) => node.classList.toggle('selected', node === button));
    const preset = button.dataset.range;
    $('#custom-range').hidden = preset !== 'custom';
    if (preset !== 'custom') { state.reportRange = makeDateRange(preset); renderReports(); }
  });
  $('#apply-report-range').addEventListener('click', () => {
    const from = $('#report-from').value; const to = $('#report-to').value;
    if (from && to && from > to) return toast('วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด', 'warning');
    state.reportRange = { from, to, preset: 'custom' }; renderReports();
  });
  $('#report-from').value = todayKey(); $('#report-to').value = todayKey();
  $('#export-report').addEventListener('click', exportReport);
  $('#add-product').addEventListener('click', () => openProductEditor());
  $('#product-admin-list').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-product]'); if (edit) return openProductEditor(edit.dataset.editProduct);
    const toggle = event.target.closest('[data-toggle-product]'); if (toggle) toggleProduct(toggle.dataset.toggleProduct);
  });
  $('#export-backup').addEventListener('click', () => exportBackup().catch((error) => showError(error, 'ส่งออกข้อมูลสำรองไม่สำเร็จ')));
  $('#import-backup-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    try { await importBackupFile(file); } catch (error) { showError(error, 'นำเข้าข้อมูลสำรองไม่สำเร็จ'); }
    finally { event.target.value = ''; }
  });
  $('#cloud-config-form').addEventListener('submit', saveCloudConfig);
  $('#cloud-auth-form').addEventListener('submit', cloudLogin);
  $('#cloud-signup').addEventListener('click', cloudSignup);
  $('#cloud-logout').addEventListener('click', cloudLogout);
  $('#manual-sync').addEventListener('click', () => {
    if (!state.cloudReady) return prepareCloudSession();
    runCloudUpload({ quiet: false }).catch((error) => showError(error, 'สำรองข้อมูลไม่สำเร็จ'));
  });
  $('#refresh-app').addEventListener('click', async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) await registration.update();
      toast('ตรวจสอบเวอร์ชันแล้ว หากมีอัปเดตให้ปิดแล้วเปิดแอปใหม่');
    } catch (error) { showError(error, 'ตรวจสอบเวอร์ชันไม่สำเร็จ'); }
  });
  window.addEventListener('online', () => onNetworkOnline().catch((error) => setCloudMessage(error.message, 'error')));
  window.addEventListener('offline', () => {
    updateCloudStatusLine();
    if (readSession()) setCloudMessage('ออฟไลน์อยู่ ข้อมูลขายจะบันทึกในเครื่องและซิงก์เมื่อกลับมาออนไลน์', 'warning');
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); state.installPrompt = event; $('#install-app').hidden = false;
  });
  $('#install-app').addEventListener('click', async () => {
    if (!state.installPrompt) return toast('ใช้เมนูของเบราว์เซอร์เพื่อเพิ่มแอปลงหน้าจอหลัก', 'warning');
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null; $('#install-app').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#install-app').hidden = true; $('#install-about').textContent = 'ติดตั้งแล้ว'; toast('ติดตั้ง JUST MELLOW POS แล้ว'); });
}

async function init() {
  try {
    await openDB();
    await refreshData();
    installEvents();
    renderPos(); renderHistory(); renderReports(); renderProducts();
    $('#today-chip').textContent = dateLabel(new Date());
    updateCloudStatusLine();
    await updateStorageStats();
    await updateCloudUi();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      try { await navigator.serviceWorker.register('./sw.js'); }
      catch (error) { console.warn('Service worker registration failed:', error); }
    }
    if (readSession()) await prepareCloudSession();
    $('#install-about').textContent = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'ติดตั้งแล้ว' : 'เพิ่มบนหน้าจอหลักได้';
  } catch (error) {
    console.error(error);
    const root = $('#main-content');
    root.innerHTML = `<div class="blank-state"><strong>เปิดฐานข้อมูลในเครื่องไม่สำเร็จ</strong><p style="font-size:12px;margin-top:8px">${escapeHtml(error.message || error)}</p><p style="font-size:11px">กรุณาเปิดผ่าน HTTPS หรือ localhost ในเบราว์เซอร์ที่รองรับ IndexedDB</p></div>`;
  }
}

init();
