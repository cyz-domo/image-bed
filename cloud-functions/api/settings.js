import { readSession } from "../_lib/auth.js";
import { loadState, updateState, setSetting } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

const EDITABLE = new Set(["hero_background_url", "daily_upload_limit", "max_file_mb"]);
const LIMITS = { daily_upload_limit: [1, 10000], max_file_mb: [1, 100] };

function toNumber(value, [min, max]) { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : null; }

export async function onRequest({ request, env }) {
  try {
    const state = await loadState(env);
    if (request.method === "GET") {
      return json({
        settings: state.settings || {},
        defaults: { daily_upload_limit: Number(env.DAILY_UPLOAD_LIMIT || 100), max_file_mb: Number(env.MAX_FILE_SIZE || 10485760) / 1048576 },
      });
    }
    if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 GET 和 POST", 405);
    const session = await readSession(request, env); if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
    const body = await request.json().catch(() => ({}));
    const entries = Object.entries(body || {}).filter(([key]) => EDITABLE.has(key));
    if (!entries.length) return error("SETTING_INVALID", "没有可更新的设置项", 400);
    for (const [key, value] of entries) {
      if (key === "hero_background_url") { if (typeof value !== "string" || value.length > 2048) return error("SETTING_INVALID", "背景图地址不合法", 400); }
      else if (toNumber(value, LIMITS[key]) === null) return error("SETTING_INVALID", `${key === "daily_upload_limit" ? "每日上限" : "大小上限"}需在 ${LIMITS[key][0]} 到 ${LIMITS[key][1]} 之间`, 400);
    }
    await updateState((s) => entries.forEach(([key, value]) => setSetting(s, key, value)), env);
    return json({ ok: true, settings: { ...(await loadState(env)).settings } });
  } catch (cause) { return error("SETTINGS_FAILED", cause?.message || "设置读取失败", 502); }
}
