import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseMoneyToSatang, formatMoney, filterSalesByRange, summarizeSales,
  buildCsv, escapeCsvCell, validateProductInput, normalizeBackup, makeDateRange
} from '../domain.js';

test('money parser uses integer satang and rejects invalid/negative values', () => {
  assert.equal(parseMoneyToSatang('25'), 2500);
  assert.equal(parseMoneyToSatang('25.55'), 2555);
  assert.equal(parseMoneyToSatang('1,250.25'), 125025);
  assert.equal(parseMoneyToSatang(''), null);
  assert.equal(parseMoneyToSatang('-1'), null);
  assert.equal(parseMoneyToSatang('abc'), null);
  assert.equal(formatMoney(3050).includes('30.50'), true);
});

test('summary excludes cancelled sales from net while retaining gross issued total', () => {
  const sales = [
    { id: '1', status: 'completed', totalSatang: 5000, paymentMethod: 'cash', items: [{ productId: 'tea', name: 'ชา', category: 'ชา', quantity: 2, unitPriceSatang: 2500, unitCostSatang: 1000, lineTotalSatang: 5000 }] },
    { id: '2', status: 'cancelled', totalSatang: 3000, paymentMethod: 'qr', items: [{ productId: 'pud', name: 'พุดดิ้ง', category: 'ขนม', quantity: 1, unitPriceSatang: 3000, unitCostSatang: 1000, lineTotalSatang: 3000 }] }
  ];
  const result = summarizeSales(sales);
  assert.equal(result.grossIssuedSatang, 8000);
  assert.equal(result.netSalesSatang, 5000);
  assert.equal(result.issuedBillCount, 2);
  assert.equal(result.completedBillCount, 1);
  assert.equal(result.cancelledBillCount, 1);
  assert.equal(result.itemCount, 2);
  assert.equal(result.paymentTotals.cash, 5000);
  assert.equal(result.paymentTotals.qr, 0);
  assert.equal(result.costSatang, 2000);
  assert.equal(result.grossProfitSatang, 3000);
  assert.equal(result.grossMarginPercent, 60);
});

test('missing product cost marks profit incomplete instead of inventing zero cost', () => {
  const result = summarizeSales([{ id: '1', status: 'completed', totalSatang: 1500, paymentMethod: 'transfer', items: [{ productId: 'x', name: 'ทดลอง', quantity: 1, unitPriceSatang: 1500, unitCostSatang: null, lineTotalSatang: 1500 }] }]);
  assert.equal(result.hasMissingCost, true);
  assert.equal(result.costSatang, null);
  assert.equal(result.grossProfitSatang, null);
  assert.equal(result.grossMarginPercent, null);
  assert.equal(result.bestSellers[0].grossProfitSatang, null);
});

test('range filtering compares local calendar dates; presets return expected keys', () => {
  const sales = [
    { createdAt: new Date(2026, 9, 8, 12).toISOString() },
    { createdAt: new Date(2026, 9, 9, 12).toISOString() }
  ];
  const from = `${new Date(2026, 9, 9).getFullYear()}-${String(new Date(2026, 9, 9).getMonth()+1).padStart(2,'0')}-09`;
  assert.equal(filterSalesByRange(sales, from, from).length, 1);
  const range = makeDateRange('yesterday', new Date(2026, 9, 9, 14));
  assert.equal(range.from, '2026-10-08');
  assert.equal(range.to, '2026-10-08');
});

test('CSV escapes quotes/commas and formula-like text; UTF-8 BOM is included', () => {
  assert.equal(escapeCsvCell('a,"b"'), '"a,""b"""');
  assert.equal(escapeCsvCell('=1+1'), "\"'=1+1\"");
  assert.equal(escapeCsvCell('-cmd|x'), "\"'-cmd|x\"");
  assert.equal(escapeCsvCell('-12.50'), '"-12.50"');
  assert.ok(buildCsv([['หัวข้อ', 'ค่า']]).startsWith('\uFEFF'));
});

test('product validation requires name/category/positive price, permits blank cost', () => {
  const okay = validateProductInput({ name: 'ชา', category: 'เครื่องดื่ม', price: '35', cost: '' });
  assert.equal(okay.valid, true);
  assert.equal(okay.value.priceSatang, 3500);
  assert.equal(okay.value.costSatang, null);
  assert.equal(validateProductInput({ name: '', category: 'ชา', price: '0', cost: '' }).valid, false);
  assert.equal(validateProductInput({ name: 'ชา', category: 'ชา', price: '35', cost: '-2' }).valid, false);
});

test('backup normalizer rejects duplicate products, duplicate bills and malformed payload', () => {
  assert.throws(() => normalizeBackup({ schemaVersion: 2, products: [], sales: [] }));
  assert.throws(() => normalizeBackup({ schemaVersion: 1, products: [{ id: 'a', name: 'A', priceSatang: 100 }, { id: 'a', name: 'B', priceSatang: 100 }], sales: [] }));
  assert.throws(() => normalizeBackup({ schemaVersion: 1, products: [], sales: [{ id: 'x', items: [], totalSatang: 100, status: 'completed' }, { id: 'x', items: [], totalSatang: 100, status: 'completed' }] }));
  const valid = normalizeBackup({ schemaVersion: 1, products: [], sales: [] });
  assert.equal(valid.shopName, 'JUST MELLOW');
});


test('sample backup fixture is structurally valid and has expected report totals', async () => {
  const raw = JSON.parse(await readFile(new URL('./sample-backup.json', import.meta.url), 'utf8'));
  const backup = normalizeBackup(raw);
  const result = summarizeSales(backup.sales);
  assert.equal(backup.products.length, 13);
  assert.equal(backup.sales.length, 3);
  assert.equal(result.netSalesSatang, 19000);
  assert.equal(result.grossIssuedSatang, 24000);
  assert.equal(result.completedBillCount, 2);
  assert.equal(result.cancelledBillCount, 1);
  assert.equal(result.costSatang, 7300);
  assert.equal(result.grossProfitSatang, 11700);
});
