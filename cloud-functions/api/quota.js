import { readSession } from "../_lib/auth.js";
import { loadState } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

const defaultDailyLimit = 100;
const todayKey = () => new Date().toISOString().slice(0, 10);
export async function onRequest({ request, env }) {
  if (request.method !== "GET") return error("METHOD_NOT_ALLOWED", "只支持 GET", 405);
  if (!(await readSession(request, env))) return error("UNAUTHENTICATED", "登录后查看额度", 401);
  try {
    const state = await loadState(env);
    const limit = Number(state.settings?.daily_upload_limit || env.DAILY_UPLOAD_LIMIT || defaultDailyLimit);
    const key = todayKey();
    return json({ key, limit, used: state.daily?.key === key ? Number(state.daily.count || 0) : 0, remaining: Math.max(0, limit - (state.daily?.key === key ? Number(state.daily.count || 0) : 0)) }, 200, { "Cache-Control": "no-store" });
  } catch { return error("QUOTA_UNAVAILABLE", "每日额度暂不可用", 503); }
}
