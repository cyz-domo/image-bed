import { readSession } from "../_lib/auth.js";
import { loadState, updateState, setSetting } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

const EDITABLE = new Set(["hero_background_url"]);

export async function onRequest({ request, env }) {
  try {
    const state = await loadState(env);
    if (request.method === "GET") return json({ settings: state.settings || {} });
    if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 GET 和 POST", 405);
    const session = await readSession(request, env); if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
    const body = await request.json().catch(() => ({}));
    const entries = Object.entries(body || {}).filter(([key]) => EDITABLE.has(key));
    if (!entries.length) return error("SETTING_INVALID", "没有可更新的设置项", 400);
    for (const [, value] of entries) if (typeof value !== "string" || value.length > 2048) return error("SETTING_INVALID", "设置值不合法", 400);
    await updateState((s) => entries.forEach(([key, value]) => setSetting(s, key, value)), env);
    return json({ ok: true, settings: { ...(await loadState(env)).settings } });
  } catch (cause) { return error("SETTINGS_FAILED", cause?.message || "设置读取失败", 502); }
}
