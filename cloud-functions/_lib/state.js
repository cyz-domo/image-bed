import { ghApi } from "./github.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// KV 变量名：在 EdgeOne 控制台将 KV namespace 绑定到项目时，变量名需为 IMAGE_KV。
// 未绑定/不可用时自动回退到 GitHub 仓库状态文件，功能不受影响。
const STATE_KEY = "state";
const STATE_PATH = ".state/state.json";

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });

let kvWarned = false;
function kv(env) {
  const store = runtimeEnv(env).IMAGE_KV;
  if (!store) {
    if (!kvWarned) {
      console.warn("[KV] IMAGE_KV binding not found – falling back to GitHub state storage.");
      kvWarned = true;
    }
    return null;
  }
  if (typeof store.get !== "function" || typeof store.put !== "function") {
    if (!kvWarned) {
      console.warn("[KV] Unexpected store interface – falling back to GitHub state storage.");
      kvWarned = true;
    }
    return null;
  }
  return store;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function b64Encode(text) { const bytes = encoder.encode(text); let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); }

export function freshState() { return { revoked: [], daily: {}, settings: {}, links: {}, owners: {} }; }

/* ---------- 身份脱敏 ----------
   状态文件写在公开仓库里，知道路径的人就能取到，所以"谁传了哪张图""谁今天传了几张"
   不该以明文 GitHub 用户名落盘。落盘前折算成 SESSION_SECRET 派生的不可逆 id：
   配额与归属判定照常工作（比对双方都换算），对外只是一串十六进制。
   注意：轮换 SESSION_SECRET 会让历史归属认不出来，需要连同旧值一起迁移。 */
const USER_ID = /^[0-9a-f]{12}$/;
const STORAGE_ONLY_DAILY_KEYS = new Set(["key", "count"]); // 早期全站计数器，已无人读取，脱敏时顺手清掉
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function userId(env, login) {
  const name = String(login || "").trim().toLowerCase();
  if (!name) return "";
  if (USER_ID.test(name)) return name;
  const secret = runtimeEnv(env).SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET 未配置，无法折算用户标识");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(name))).subarray(0, 6));
}

// 兼容尚未脱敏的历史值：文件里可能仍是明文 login，写过一次之后就只认 id
export function ownerMatches(stored, id, login) {
  const value = String(stored || "").trim();
  if (!value) return false;
  if (value.toLowerCase() === String(id || "").toLowerCase()) return true;
  return value.toLowerCase() === String(login || "").trim().toLowerCase();
}

/* ---------- GitHub 仓库状态文件（兜底存储） ---------- */
const gh = { sha: null, data: null, loadedAt: 0 };
const GH_TTL_MS = 15000;

async function ghLoad(env) {
  if (gh.data && Date.now() - gh.loadedAt < GH_TTL_MS) return gh.data;
  const response = await ghApi(env, `contents/${STATE_PATH}?ref=main`);
  if (response.status === 404) { gh.data = freshState(); gh.sha = null; }
  else {
    if (!response.ok) throw new Error(`状态文件读取失败 (${response.status})`);
    const body = await response.json();
    gh.sha = body.sha;
    gh.data = { ...freshState(), ...JSON.parse(decoder.decode(Uint8Array.from(atob(body.content.replace(/\s/g, "")), (c) => c.charCodeAt(0)))) };
  }
  gh.loadedAt = Date.now();
  return gh.data;
}

async function ghSave(state, env) {
  const content = b64Encode(JSON.stringify(state));
  const response = await ghApi(env, `contents/${STATE_PATH}`, { method: "PUT", body: JSON.stringify({ message: "chore: update state", content, branch: "main", ...(gh.sha ? { sha: gh.sha } : {}) }) });
  if (!response.ok) { gh.loadedAt = 0; throw new Error(`状态文件写入失败 (${response.status})`); }
  gh.sha = (await response.json()).content.sha;
  gh.loadedAt = Date.now();
}

/* ---------- 统一状态读写 ---------- */
const kvMemo = { data: null, loadedAt: 0 };

// 读出的状态一律先过这里脱敏：owners/daily 里的明文 login 折算成 id、昨天的计数丢弃、
// 已被环境变量接管的 allowed_users 删除。改动随下一次状态写入自然落到仓库。
export async function sanitizeState(state, env) {
  const plain = new Set();
  for (const value of Object.values(state.owners || {})) {
    const name = String(value || "").trim();
    if (name && !USER_ID.test(name.toLowerCase())) plain.add(name);
  }
  for (const name of Object.keys(state.daily || {})) {
    if (!STORAGE_ONLY_DAILY_KEYS.has(name) && !USER_ID.test(name.toLowerCase())) plain.add(name);
  }
  if (!plain.size && !runtimeEnv(env).ALLOWED_USERS && !state.daily?.key && !state.daily?.count) return state;
  const hashed = new Map();
  for (const name of plain) hashed.set(name.toLowerCase(), await userId(env, name));
  const toId = (value) => (USER_ID.test(String(value || "").toLowerCase()) ? String(value).toLowerCase() : hashed.get(String(value || "").trim().toLowerCase()));

  const owners = {};
  for (const [path, value] of Object.entries(state.owners || {})) {
    const id = toId(value);
    if (id) owners[path] = id;
  }
  const today = todayKey();
  const daily = {};
  for (const [name, entry] of Object.entries(state.daily || {})) {
    if (STORAGE_ONLY_DAILY_KEYS.has(name) || !entry || entry.key !== today) continue;
    const id = toId(name);
    if (id) daily[id] = { key: entry.key, count: Number(entry.count || 0) };
  }
  const settings = { ...(state.settings || {}) };
  if (runtimeEnv(env).ALLOWED_USERS) delete settings.allowed_users;
  return { ...state, owners, daily, settings };
}

export async function loadState(env) {
  const store = kv(env);
  if (store) {
    if (kvMemo.data && Date.now() - kvMemo.loadedAt < 15000) return kvMemo.data;
    const raw = await store.get(STATE_KEY, { type: "json" });
    kvMemo.data = await sanitizeState(raw ? { ...freshState(), ...raw } : freshState(), env);
    kvMemo.loadedAt = Date.now();
    return kvMemo.data;
  }
  return sanitizeState(await ghLoad(env), env);
}

// read -> mutate -> save 持实例内锁；KV 最终一致（其他节点最多延迟 60 秒），单人图床可接受
let writing = null;
export async function updateState(mutator, env) {
  // 防止写锁长时间阻塞导致函数超时
  await Promise.race([
    (async () => { while (writing) await writing; })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stateLock timeout")), 5000))
  ]);
  const run = (async () => {
    const state = await loadState(env);
    const result = mutator(state);
    const store = kv(env);
    if (store) { await store.put(STATE_KEY, JSON.stringify(state)); kvMemo.data = state; kvMemo.loadedAt = Date.now(); }
    else await ghSave(state, env);
    return result;
  })();
  writing = run.finally(() => { writing = null; });
  return run;
}

// 每日配额按用户独立计数：这里收 GitHub login（也可能是已脱敏的 id，userId 对两者幂等），
// 落盘只用不可逆 id；limit 为每用户每日上限
export async function reserveDailyQuota(env, limit, owner = "default") {
  const ownerId = await userId(env, owner);
  const store = kv(env);
  const increment = typeof store?.incr === "function" ? store.incr : store?.increment;
  if (!store || typeof increment !== "function") {
    const key = todayKey();
    const state = await loadState(env);
    const entry = state.daily?.[ownerId];
    const count = entry?.key === key ? Number(entry.count || 0) : 0;
    if (count >= limit) return { allowed: false, used: count, remaining: 0, key, fallback: true };
    state.daily = { ...state.daily, [ownerId]: { key, count: count + 1 } };
    return { allowed: true, used: count + 1, remaining: limit - count - 1, key, fallback: true };
  }
  const key = `daily_uploads:${ownerId}:${todayKey()}`;
  const used = Number(await increment.call(store, key, 1));
  if (!Number.isFinite(used) || used < 1) throw Object.assign(new Error("每日配额计数返回值无效"), { code: "QUOTA_STORE_UNAVAILABLE" });
  if (used > limit) { try { await increment.call(store, key, -1); } catch {} return { allowed: false, used: used - 1, remaining: 0 }; }
  return { allowed: true, used, remaining: limit - used, key };
}

export async function readDailyUsed(env, owner = "default") {
  const ownerId = await userId(env, owner);
  const store = kv(env);
  const key = `daily_uploads:${ownerId}:${todayKey()}`;
  if (store) { try { const raw = await store.get(key); const used = Number(raw ?? 0); return Number.isFinite(used) ? used : 0; } catch { return 0; } }
  const state = await loadState(env); const entry = state.daily?.[ownerId]; return entry?.key === todayKey() ? Number(entry.count || 0) : 0;
}

export async function releaseDailyQuota(env, reservation) {
  const store = kv(env);
  const increment = typeof store?.incr === "function" ? store.incr : store?.increment;
  if (reservation?.key && typeof increment === "function") await increment.call(store, reservation.key, -1);
}

export function revokeSession(state, sessionId) { if (!state.revoked.includes(sessionId)) state.revoked.push(sessionId); if (state.revoked.length > 200) state.revoked.splice(0, state.revoked.length - 200); }
export function bumpDailyCount(state) { const key = todayKey(); if (state.daily.key !== key) state.daily = { key, count: 0 }; state.daily.count += 1; return state.daily.count; }
export function setSetting(state, name, value) { state.settings = { ...state.settings, [name]: value }; }

const historyMemory = { expires: 0, items: [] };
export function readMemoryHistory() { return Date.now() < historyMemory.expires ? historyMemory.items : null; }
export function writeMemoryHistory(items, ttl = 60000) { historyMemory.items = items; historyMemory.expires = Date.now() + ttl; }
export function invalidateHistoryCache() { historyMemory.items = []; historyMemory.expires = 0; }

/* ---------- 历史列表 KV 缓存（跨实例共享，避免每次回源 GitHub tree） ---------- */
export async function readHistoryCache(env) {
  const store = kv(env);
  if (!store) return null;
  const raw = await store.get("history_cache", { type: "json" }).catch(() => null);
  return raw && typeof raw.items === "object" ? raw : null;
}
export async function writeHistoryCache(env, items) {
  const store = kv(env);
  if (!store) return;
  await store.put("history_cache", JSON.stringify({ items, savedAt: Date.now() })).catch(() => {});
}
