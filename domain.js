export const PAYMENT_METHODS = {
  cash: 'เงินสด',
  qr: 'QR Code',
  transfer: 'โอนเงิน'
};

export function parseMoneyToSatang(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text) return null;
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round((num + Number.EPSILON) * 100);
}

export function formatMoney(satang, opts = {}) {
  if (satang === null || satang === undefined || !Number.isFinite(Number(satang))) return 'ยังไม่ระบุ';
  return new Intl.NumberFormat('th-TH', {
    style: 'currency', currency: 'THB', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Number(satang) / 100);
}

export function toDateKey(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function makeDateRange(preset, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (preset === 'yesterday') {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (preset === '7days') {
    start.setDate(start.getDate() - 6);
  } else if (preset === 'month') {
    start.setDate(1);
  }
  return { from: toDateKey(start), to: toDateKey(end), preset };
}

export function filterSalesByRange(sales, from, to) {
  return sales.filter((sale) => {
    const key = toDateKey(sale.createdAt);
    return key && (!from || key >= from) && (!to || key <= to);
  });
}

export function summarizeSales(sales, products = []) {
  const nonVoided = sales.filter((sale) => sale.status !== 'cancelled');
  const grossIssuedSatang = sales.reduce((sum, sale) => sum + Number(sale.totalSatang || 0), 0);
  const netSalesSatang = nonVoided.reduce((sum, sale) => sum + Number(sale.totalSatang || 0), 0);
  const itemCount = nonVoided.reduce((sum, sale) => sum + (sale.items || []).reduce((n, item) => n + Number(item.quantity || 0), 0), 0);
  const paymentTotals = { cash: 0, qr: 0, transfer: 0 };
  const soldProducts = new Map();
  let costSatang = 0;
  let hasMissingCost = false;
  let activeItemCount = 0;
  for (const sale of nonVoided) {
    if (Object.hasOwn(paymentTotals, sale.paymentMethod)) paymentTotals[sale.paymentMethod] += Number(sale.totalSatang || 0);
    for (const item of sale.items || []) {
      const qty = Number(item.quantity || 0);
      const key = item.productId || `${item.name}-${item.category || ''}`;
      const current = soldProducts.get(key) || {
        productId: item.productId || '', name: item.name || 'สินค้าไม่ระบุชื่อ', category: item.category || '',
        quantity: 0, salesSatang: 0, costSatang: 0, missingCost: false
      };
      current.quantity += qty;
      current.salesSatang += Number(item.lineTotalSatang ?? (Number(item.unitPriceSatang || 0) * qty));
      if (item.unitCostSatang === null || item.unitCostSatang === undefined || !Number.isFinite(Number(item.unitCostSatang))) {
        current.missingCost = true;
        hasMissingCost = true;
      } else {
        const itemCost = Number(item.unitCostSatang) * qty;
        current.costSatang += itemCost;
        costSatang += itemCost;
      }
      activeItemCount += qty;
      soldProducts.set(key, current);
    }
  }
  const productRows = [...soldProducts.values()].map((row) => ({
    ...row,
    grossProfitSatang: row.missingCost ? null : row.salesSatang - row.costSatang
  }));
  const bestSellers = [...productRows].sort((a, b) => b.quantity - a.quantity || b.salesSatang - a.salesSatang);
  const slowSellers = [...productRows].sort((a, b) => a.quantity - b.quantity || a.salesSatang - b.salesSatang);
  const completedBillCount = nonVoided.length;
  const cancelledBillCount = sales.length - nonVoided.length;
  const costsComplete = nonVoided.length > 0 && !hasMissingCost;
  const grossProfitSatang = costsComplete ? netSalesSatang - costSatang : null;
  const grossMarginPercent = costsComplete && netSalesSatang > 0 ? (grossProfitSatang / netSalesSatang) * 100 : null;
  return {
    issuedBillCount: sales.length,
    completedBillCount,
    cancelledBillCount,
    grossIssuedSatang,
    netSalesSatang,
    itemCount,
    paymentTotals,
    soldProducts: productRows,
    bestSellers,
    slowSellers,
    costSatang: hasMissingCost ? null : costSatang,
    grossProfitSatang,
    grossMarginPercent,
    costsComplete,
    hasMissingCost,
    activeItemCount
  };
}

export function escapeCsvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // CSV formula injection defense for values controlled by the user.
  if (/^[\s\u0000-\u001f]*[=+@]/.test(text) || /^[\s\u0000-\u001f]*-[^0-9\s.]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(rows) {
  return '\uFEFF' + rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}

export function validateProductInput(input) {
  const name = String(input.name || '').trim();
  const category = String(input.category || '').trim();
  const priceSatang = parseMoneyToSatang(input.price);
  const costText = String(input.cost ?? '').trim();
  const costSatang = costText === '' ? null : parseMoneyToSatang(costText);
  const errors = [];
  if (!name) errors.push('กรุณากรอกชื่อสินค้า');
  if (!category) errors.push('กรุณาเลือกหมวดหมู่');
  if (priceSatang === null || priceSatang <= 0) errors.push('ราคาขายต้องมากกว่า 0 บาท');
  if (costText !== '' && (costSatang === null || costSatang < 0)) errors.push('ต้นทุนต้องเป็นตัวเลขตั้งแต่ 0 บาทขึ้นไป หรือเว้นว่างไว้');
  return { valid: errors.length === 0, errors, value: { name, category, priceSatang, costSatang } };
}

export function normalizeBackup(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !Array.isArray(value.products) || !Array.isArray(value.sales)) {
    throw new Error('รูปแบบไฟล์สำรองไม่ถูกต้องหรือไม่รองรับ');
  }
  const ids = new Set();
  for (const product of value.products) {
    if (!product || typeof product.id !== 'string' || !product.id || typeof product.name !== 'string' || !product.name.trim() || typeof product.category !== 'string' || !product.category.trim() || !Number.isInteger(product.priceSatang) || product.priceSatang <= 0) {
      throw new Error('พบข้อมูลสินค้าไม่ถูกต้องในไฟล์สำรอง');
    }
    if (product.costSatang !== null && product.costSatang !== undefined && (!Number.isInteger(product.costSatang) || product.costSatang < 0)) {
      throw new Error(`ต้นทุนของสินค้า ${product.name} ไม่ถูกต้องในไฟล์สำรอง`);
    }
    if (ids.has(product.id)) throw new Error('พบรหัสสินค้าซ้ำในไฟล์สำรอง');
    ids.add(product.id);
  }
  const saleIds = new Set();
  for (const sale of value.sales) {
    if (!sale || typeof sale.id !== 'string' || !sale.id || typeof sale.receiptNo !== 'string' || !sale.receiptNo || !Array.isArray(sale.items) || !sale.items.length || !Number.isInteger(sale.totalSatang) || sale.totalSatang < 0 || !['completed', 'cancelled'].includes(sale.status) || !['cash', 'qr', 'transfer'].includes(sale.paymentMethod) || !sale.createdAt || Number.isNaN(Date.parse(sale.createdAt))) {
      throw new Error('พบข้อมูลบิลไม่ถูกต้องในไฟล์สำรอง');
    }
    if (saleIds.has(sale.id)) throw new Error('พบรหัสบิลซ้ำในไฟล์สำรอง');
    saleIds.add(sale.id);
    let calculatedTotal = 0;
    for (const item of sale.items) {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || !Number.isInteger(item.quantity) || item.quantity <= 0 || !Number.isInteger(item.unitPriceSatang) || item.unitPriceSatang < 0 || !Number.isInteger(item.lineTotalSatang) || item.lineTotalSatang !== item.quantity * item.unitPriceSatang) {
        throw new Error(`พบรายการสินค้าไม่ถูกต้องในบิล ${sale.receiptNo}`);
      }
      if (item.unitCostSatang !== null && item.unitCostSatang !== undefined && (!Number.isInteger(item.unitCostSatang) || item.unitCostSatang < 0)) {
        throw new Error(`พบต้นทุนไม่ถูกต้องในบิล ${sale.receiptNo}`);
      }
      calculatedTotal += item.lineTotalSatang;
    }
    if (calculatedTotal !== sale.totalSatang) throw new Error(`ยอดรวมบิล ${sale.receiptNo} ไม่ตรงกับรายการสินค้า`);
  }
  return { schemaVersion: 1, shopName: String(value.shopName || 'JUST MELLOW'), exportedAt: value.exportedAt || new Date().toISOString(), products: value.products, sales: value.sales };
}
