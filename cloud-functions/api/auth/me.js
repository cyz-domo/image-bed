import { readSession, clearOauthStateCookie, isAdminSession } from "../../_lib/auth.js";
import { loadState, readDailyUsed } from "../../_lib/state.js";
import { error } from "../../_lib/http.js";

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });

// 首屏要用的数据一次给全：me 顺带返回设置（匿名访客的背景图也靠它）和额度，
// 浏览器就不用为 /api/settings、/api/quota、/api/history 之前的各自回源排队
async function bootPayload(session, env) {
  const config = runtimeEnv(env);
  const state = await loadState(env);
  const is_admin = session ? isAdminSession(session, env) : false;
  const limit = Number(state.settings?.daily_upload_limit || config.DAILY_UPLOAD_LIMIT || 100);
  const used = session ? await readDailyUsed(env, session.login) : 0;
  return {
    is_admin,
    // allowed_users 仅对管理员可见，与 /api/settings 保持一致的过滤
    settings: is_admin ? { ...(state.settings || {}) } : Object.fromEntries(Object.entries(state.settings || {}).filter(([key]) => key !== "allowed_users")),
    defaults: { daily_upload_limit: Number(config.DAILY_UPLOAD_LIMIT || 100), max_file_mb: Number(config.MAX_FILE_SIZE || 10485760) / 1048576 },
    ...(session ? { quota: { key: new Date().toISOString().slice(0, 10), limit, used, remaining: Math.max(0, limit - used) } } : {}),
  };
}

export async function onRequest({ request, env }) {
  try {
    const session = await readSession(request, env);
    const base = session ? { authenticated: true, login: session.login, avatar_url: session.avatar_url || null } : { authenticated: false };
    let payload = base;
    try { payload = { ...base, ...(await bootPayload(session, env)) }; } catch { /* 附带数据读不到时登录态照常可用，前端会各自回退补拉 */ }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "Set-Cookie": clearOauthStateCookie() } });
  } catch {
    return error("AUTH_FAILED", "认证暂不可用，请稍后重试", 503);
  }
}
