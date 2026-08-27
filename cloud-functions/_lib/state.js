import { ghApi } from "./github.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// KV 变量名：在 EdgeOne 控制台将 KV namespace 绑定到项目时，变量名需为 IMAGE_KV。
// 未绑定/不可用时自动回退到 GitHub 仓库状态文件，功能不受影响。
const STATE_KEY = "state";
const STATE_PATH = ".state/state.json";

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });

function kv(env) {
  const store = runtimeEnv(env).IMAGE_KV;
  return store && typeof store.get === "function" && typeof store.put === "function" ? store : null;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function b64Encode(text) { const bytes = encoder.encode(text); let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); }

export function freshState() { return { revoked: [], daily: {}, settings: {} }; }

/* ---------- GitHub 仓库状态文件（兜底存储） ---------- */
const gh = { sha: null, data: null, loadedAt: 0 };
const GH_TTL_MS = 15000;

async function ghLoad() {
  if (gh.data && Date.now() - gh.loadedAt < GH_TTL_MS) return gh.data;
  const response = await ghApi(null, `contents/${STATE_PATH}?ref=main`);
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

async function ghSave(state) {
  const content = b64Encode(JSON.stringify(state));
  const response = await ghApi(null, `contents/${STATE_PATH}`, { method: "PUT", body: JSON.stringify({ message: "chore: update state", content, branch: "main", ...(gh.sha ? { sha: gh.sha } : {}) }) });
  if (!response.ok) { gh.loadedAt = 0; throw new Error(`状态文件写入失败 (${response.status})`); }
  gh.sha = (await response.json()).content.sha;
  gh.loadedAt = Date.now();
}

/* ---------- 统一状态读写 ---------- */
const kvMemo = { data: null, loadedAt: 0 };
export async function loadState(env) {
  const store = kv(env);
  if (store) {
    if (kvMemo.data && Date.now() - kvMemo.loadedAt < 15000) return kvMemo.data;
    const raw = await store.get(STATE_KEY, { type: "json" });
    kvMemo.data = raw ? { ...freshState(), ...raw } : freshState();
    kvMemo.loadedAt = Date.now();
    return kvMemo.data;
  }
  return ghLoad();
}

// read -> mutate -> save 持实例内锁；KV 最终一致（其他节点最多延迟 60 秒），单人图床可接受
let writing = null;
export async function updateState(mutator, env) {
  while (writing) await writing;
  const run = (async () => {
    const state = await loadState(env);
    const result = mutator(state);
    const store = kv(env);
    if (store) { await store.put(STATE_KEY, JSON.stringify(state)); kvMemo.data = state; kvMemo.loadedAt = Date.now(); }
    else await ghSave(state);
    return result;
  })();
  writing = run.finally(() => { writing = null; });
  return run;
}

export function revokeSession(state, sessionId) { if (!state.revoked.includes(sessionId)) state.revoked.push(sessionId); if (state.revoked.length > 200) state.revoked.splice(0, state.revoked.length - 200); }
export function bumpDailyCount(state) { const key = todayKey(); if (state.daily.key !== key) state.daily = { key, count: 0 }; state.daily.count += 1; return state.daily.count; }
export function setSetting(state, name, value) { state.settings = { ...state.settings, [name]: value }; }

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
