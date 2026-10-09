import { normalizeBackup } from './domain.js';

const DB_NAME = 'just-mellow-pos';
const DB_VERSION = 1;
let connection;

export const SEED_PRODUCTS = [
  { id: 'pudding-caramel', name: 'พุดดิ้งนมสดคาราเมล', category: 'พุดดิ้ง', priceSatang: 3000, costSatang: null, active: true, draft: false },
  { id: 'pudding-coffee', name: 'พุดดิ้งกาแฟ', category: 'พุดดิ้ง', priceSatang: 3000, costSatang: null, active: true, draft: false },
  { id: 'pudding-thai-tea', name: 'พุดดิ้งชาไทย', category: 'พุดดิ้ง', priceSatang: 3000, costSatang: null, active: true, draft: false },
  { id: 'pudding-green-tea', name: 'พุดดิ้งชาเขียว', category: 'พุดดิ้ง', priceSatang: 3000, costSatang: null, active: true, draft: false },
  { id: 'pudding-cocoa', name: 'พุดดิ้งโกโก้', category: 'พุดดิ้ง', priceSatang: 3000, costSatang: null, active: true, draft: false },
  { id: 'fruit-mixed', name: 'ชาผลไม้รวม', category: 'ชาผลไม้', priceSatang: 5000, costSatang: null, active: true, draft: false },
  { id: 'fruit-grape', name: 'ชาองุ่น', category: 'ชาผลไม้', priceSatang: 5000, costSatang: null, active: true, draft: false },
  { id: 'fruit-apple', name: 'ชาแอปเปิล', category: 'ชาผลไม้', priceSatang: 5000, costSatang: null, active: true, draft: false },
  { id: 'fruit-orange', name: 'ชาส้ม', category: 'ชาผลไม้', priceSatang: 5000, costSatang: null, active: true, draft: false },
  { id: 'shake-chocolate', name: 'มิลค์เชคช็อกโกแลต', category: 'มิลค์เชค', priceSatang: 5000, costSatang: null, active: false, draft: true },
  { id: 'shake-vanilla', name: 'มิลค์เชควานิลลา', category: 'มิลค์เชค', priceSatang: 5000, costSatang: null, active: false, draft: true },
  { id: 'shake-strawberry', name: 'มิลค์เชคสตรอว์เบอร์รี', category: 'มิลค์เชค', priceSatang: 5500, costSatang: null, active: false, draft: true },
  { id: 'shake-coffee', name: 'มิลค์เชคกาแฟ', category: 'มิลค์เชค', priceSatang: 5000, costSatang: null, active: false, draft: true }
];

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export async function openDB() {
  if (connection) return connection;
  connection = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sales')) db.createObjectStore('sales', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('เปิดฐานข้อมูลในเครื่องไม่สำเร็จ'));
    request.onblocked = () => reject(new Error('ฐานข้อมูลกำลังถูกใช้งานจากแท็บอื่น กรุณาปิดแท็บเดิมแล้วลองอีกครั้ง'));
  });
  connection.onversionchange = () => { connection.close(); connection = undefined; };
  await seedIfNeeded();
  return connection;
}

async function seedIfNeeded() {
  const db = connection;
  const tx = db.transaction(['products', 'settings'], 'readwrite');
  const productStore = tx.objectStore('products');
  const settingStore = tx.objectStore('settings');
  const countReq = productStore.count();
  countReq.onsuccess = () => {
    if (countReq.result === 0) for (const p of SEED_PRODUCTS) productStore.put({ ...p, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  };
  const shopReq = settingStore.get('shopName');
  shopReq.onsuccess = () => { if (!shopReq.result) settingStore.put({ key: 'shopName', value: 'JUST MELLOW' }); };
  await txDone(tx);
}

export async function getAll(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return reqToPromise(tx.objectStore(storeName).getAll());
}

export async function getSetting(key, fallback = null) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readonly');
  const result = await reqToPromise(tx.objectStore('settings').get(key));
  return result ? result.value : fallback;
}

export async function setSetting(key, value) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value });
  await txDone(tx);
}

export async function saveProduct(product) {
  const db = await openDB();
  const tx = db.transaction('products', 'readwrite');
  tx.objectStore('products').put(product);
  await txDone(tx);
  return product;
}

export async function deleteProduct(id) {
  const db = await openDB();
  const tx = db.transaction('products', 'readwrite');
  tx.objectStore('products').delete(id);
  await txDone(tx);
}

export async function saveSale(sale) {
  const db = await openDB();
  const tx = db.transaction('sales', 'readwrite');
  tx.objectStore('sales').add(sale);
  await txDone(tx);
  return sale;
}

export async function updateSale(sale) {
  const db = await openDB();
  const tx = db.transaction('sales', 'readwrite');
  tx.objectStore('sales').put(sale);
  await txDone(tx);
  return sale;
}

export async function getBackupPayload() {
  await openDB();
  const [products, sales, shopName] = await Promise.all([getAll('products'), getAll('sales'), getSetting('shopName', 'JUST MELLOW')]);
  return { schemaVersion: 1, shopName, exportedAt: new Date().toISOString(), products, sales };
}

export async function replaceLocalData(rawBackup) {
  const backup = normalizeBackup(rawBackup);
  const db = await openDB();
  const tx = db.transaction(['products', 'sales', 'settings'], 'readwrite');
  const products = tx.objectStore('products');
  const sales = tx.objectStore('sales');
  const settings = tx.objectStore('settings');
  products.clear();
  sales.clear();
  for (const product of backup.products) products.put(product);
  for (const sale of backup.sales) sales.put(sale);
  settings.put({ key: 'shopName', value: backup.shopName });
  await txDone(tx);
  return backup;
}

export async function clearConnectionForTest() {
  if (connection) { connection.close(); connection = undefined; }
}
