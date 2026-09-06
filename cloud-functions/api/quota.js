import { readSession } from "../_lib/auth.js";
import { loadState, readDailyUsed } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

const defaultDailyLimit = 100;
export async function onRequest({ request, env }) {
  if (request.method !== "GET") return error("METHOD_NOT_ALLOWED", "只支持 GET", 405);
  const session = await readSession(request, env); if (!session?.login) return error("UNAUTHENTICATED", "登录后查看额度", 401);
  try {
    const state = await loadState(env);
    const limit = Number(state.settings?.daily_upload_limit || env.DAILY_UPLOAD_LIMIT || defaultDailyLimit);
    const used = await readDailyUsed(env, session.login);
    return json({ key: new Date().toISOString().slice(0, 10), limit, used, remaining: Math.max(0, limit - used) }, 200, { "Cache-Control": "no-store" });
  } catch { return error("QUOTA_UNAVAILABLE", "每日额度暂不可用", 503); }
}
