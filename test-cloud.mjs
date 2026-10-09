import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signInWithPassword, signUp, getValidSession, fetchCloudBackup, uploadCloudBackup, logout, readSession
} from '../cloud.js';

const SESSION_KEY = 'jm_pos_supabase_session_v1';
class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
}
const config = { url: 'https://unit-test.supabase.co', key: 'public-test-key' };
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Supabase password auth stores session and refresh flow replaces expiring tokens', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = new MemoryStorage();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('grant_type=password')) {
      return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, user: { id: 'owner-1', email: 'test@example.com' } });
    }
    if (String(url).includes('grant_type=refresh_token')) {
      return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, user: { id: 'owner-1', email: 'test@example.com' } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const session = await signInWithPassword(config, 'test@example.com', 'secret-pass');
    assert.equal(session.access_token, 'access-1');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(JSON.parse(calls[0].options.body).email, 'test@example.com');
    assert.equal(readSession().user.id, 'owner-1');

    globalThis.localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, expires_at: Date.now() - 1000 }));
    const refreshed = await getValidSession(config);
    assert.equal(refreshed.access_token, 'access-2');
    assert.equal(refreshed.refresh_token, 'refresh-2');
    assert.equal(calls[1].options.headers.apikey, config.key);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage;
  }
});

test('Supabase signup handles email-confirmation-required response without a session', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = new MemoryStorage();
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/auth/v1/signup'));
    assert.equal(options.method, 'POST');
    return jsonResponse({ user: { id: 'owner-2', email: 'confirm@example.com' } });
  };
  try {
    const result = await signUp(config, 'confirm@example.com', 'secret-pass');
    assert.equal(result.session, null);
    assert.equal(result.confirmationRequired, true);
    assert.equal(readSession(), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage;
  }
});

test('Supabase backup fetch uses owner session and upload sends snapshot with upsert preference', async () => {
  const originalFetch = globalThis.fetch;
  const session = { access_token: 'owner-access', refresh_token: 'owner-refresh', expires_at: Date.now() + 3600000, user: { id: 'owner-3', email: 'owner@example.com' } };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'GET') return jsonResponse([{ owner_id: 'owner-3', payload: { schemaVersion: 1, products: [], sales: [] }, updated_at: '2026-10-09T10:00:00.000Z' }]);
    return new Response(null, { status: 204 });
  };
  try {
    const remote = await fetchCloudBackup(config, session);
    assert.equal(remote.owner_id, 'owner-3');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer owner-access');
    assert.ok(calls[0].url.includes('/rest/v1/pos_backups'));
    const timestamp = await uploadCloudBackup(config, session, { schemaVersion: 1, products: [], sales: [] });
    assert.ok(Date.parse(timestamp));
    assert.ok(calls[1].url.includes('on_conflict=owner_id'));
    assert.match(calls[1].options.headers.Prefer, /resolution=merge-duplicates/);
    assert.equal(JSON.parse(calls[1].options.body).owner_id, 'owner-3');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
