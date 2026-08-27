import { ghApi } from "./github.js";

const encoder = new TextEncoder();

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });

// 仓库内状态文件：会话吊销名单、每日上传计数、站点设置
const STATE_PATH = ".state/state.json";
const memory = { sha: null, data: null, loadedAt: 0 };
const MEMORY_TTL_MS = 15000;

function todayKey() { return new Date().toISOString().slice(0, 10); }
function b64Encode(text) { const bytes = encoder.encode(text); let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); }

export function freshState() { return { revoked: [], daily: {}, settings: {} }; }

export async function loadState() {
  if (memory.data && Date.now() - memory.loadedAt < MEMORY_TTL_MS) return memory.data;
  const response = await ghApi(null, `contents/${STATE_PATH}?ref=main`);
  if (response.status === 404) { memory.data = freshState(); memory.sha = null; }
  else {
    if (!response.ok) throw new Error(`状态文件读取失败 (${response.status})`);
    const body = await response.json();
    memory.sha = body.sha;
    memory.data = { ...freshState(), ...JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\s/g, "")), (c) => c.charCodeAt(0)))) };
  }
  memory.loadedAt = Date.now();
  return memory.data;
}

// read -> mutate -> save 全程持内存锁；EdgeOne 实例间无锁，靠重读合并，竞态窗口可接受（单人使用）
let writing = null;
export async function updateState(mutator) {
  while (writing) await writing;
  const run = (async () => {
    const state = await loadState();
    const result = mutator(state);
    const content = b64Encode(JSON.stringify(state));
    const response = await ghApi(null, `contents/${STATE_PATH}`, { method: "PUT", body: JSON.stringify({ message: `chore: update state`, content, branch: "main", ...(memory.sha ? { sha: memory.sha } : {}) }) });
    if (!response.ok) { memory.loadedAt = 0; throw new Error(`状态文件写入失败 (${response.status})`); }
    memory.sha = (await response.json()).content.sha;
    memory.loadedAt = Date.now();
    return result;
  })();
  writing = run.finally(() => { writing = null; });
  return run;
}

export function revokeSession(state, sessionId) { if (!state.revoked.includes(sessionId)) state.revoked.push(sessionId); if (state.revoked.length > 200) state.revoked.splice(0, state.revoked.length - 200); }
export function bumpDailyCount(state) { const key = todayKey(); if (state.daily.key !== key) state.daily = { key, count: 0 }; state.daily.count += 1; return state.daily.count; }
export function setSetting(state, name, value) { state.settings = { ...state.settings, [name]: value }; }

import { ghApi } from "./github.js";
