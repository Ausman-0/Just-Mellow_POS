const SESSION_KEY = 'jm_pos_supabase_session_v1';

export function readSession() {
  try {
    const value = localStorage.getItem(SESSION_KEY);
    if (!value) return null;
    const session = JSON.parse(value);
    if (!session?.access_token || !session?.refresh_token || !session?.user?.id) return null;
    return session;
  } catch { return null; }
}
function saveSession(session) {
  if (!session) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function cleanBaseUrl(value) { return String(value || '').trim().replace(/\/$/, ''); }

async function apiFetch(path, { url, key, method = 'GET', token, body, headers = {} }) {
  if (!url || !key) throw new Error('กรุณาตั้งค่า Supabase Project URL และ public anon/publishable key ก่อน');
  const response = await fetch(`${cleanBaseUrl(url)}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token || key}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  const text = await response.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!response.ok) {
    const message = data?.msg || data?.message || data?.error_description || data?.error || (typeof data === 'string' ? data : `HTTP ${response.status}`);
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  return data;
}

export async function signInWithPassword(config, email, password) {
  const result = await apiFetch('/auth/v1/token?grant_type=password', { ...config, method: 'POST', body: { email, password } });
  if (!result?.access_token || !result?.user?.id) throw new Error('เข้าสู่ระบบไม่สำเร็จ: ไม่พบ session ที่ใช้งานได้');
  const session = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: Date.now() + Number(result.expires_in || 3600) * 1000, user: result.user };
  saveSession(session);
  return session;
}

export async function signUp(config, email, password) {
  const result = await apiFetch('/auth/v1/signup', { ...config, method: 'POST', body: { email, password } });
  if (result?.access_token && result?.user?.id) {
    const session = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: Date.now() + Number(result.expires_in || 3600) * 1000, user: result.user };
    saveSession(session);
    return { session, confirmationRequired: false };
  }
  return { session: null, confirmationRequired: true };
}

export async function logout(config, session) {
  if (session?.access_token) {
    try { await apiFetch('/auth/v1/logout', { ...config, method: 'POST', token: session.access_token }); } catch { /* Local logout still clears the session. */ }
  }
  saveSession(null);
}

export async function getValidSession(config) {
  let session = readSession();
  if (!session) return null;
  if (session.expires_at > Date.now() + 60000) return session;
  try {
    const result = await apiFetch('/auth/v1/token?grant_type=refresh_token', { ...config, method: 'POST', body: { refresh_token: session.refresh_token } });
    session = { access_token: result.access_token, refresh_token: result.refresh_token || session.refresh_token, expires_at: Date.now() + Number(result.expires_in || 3600) * 1000, user: result.user || session.user };
    saveSession(session);
    return session;
  } catch (error) {
    saveSession(null);
    throw new Error(`session หมดอายุและต่ออายุไม่สำเร็จ กรุณาเข้าสู่ระบบใหม่: ${error.message}`);
  }
}

export async function fetchCloudBackup(config, session) {
  const data = await apiFetch('/rest/v1/pos_backups?select=owner_id,payload,updated_at&limit=1', { ...config, token: session.access_token });
  return Array.isArray(data) && data.length ? data[0] : null;
}

export async function uploadCloudBackup(config, session, payload) {
  const body = { owner_id: session.user.id, payload, updated_at: new Date().toISOString() };
  await apiFetch('/rest/v1/pos_backups?on_conflict=owner_id', {
    ...config,
    method: 'POST',
    token: session.access_token,
    body,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
  });
  return body.updated_at;
}
