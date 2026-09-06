import { readSession, authUnavailable } from "../_lib/auth.js";
import { loadState, updateState, setSetting, invalidateHistoryCache } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";
import { validPartitionConfig } from "../_lib/partition.js";

const EDITABLE = new Set(["hero_background_url", "hero_blur", "accelerator_base_url", "daily_upload_limit", "max_file_mb", "partition_config"]);
function validHeroUrl(value) { if (value === "") return true; try { const url = new URL(value.trim()); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && value.trim().length <= 2048; } catch { return false; } }
function validAccelerator(value) { if (value === "") return true; try { const url = new URL(value.trim()); return url.protocol === "https:" && !url.username && !url.password && !url.pathname.replace(/\/$/, "") && !url.search && !url.hash && value.trim().length <= 255; } catch { return false; } }
const LIMITS = { daily_upload_limit: [1, 10000], max_file_mb: [1, 20], hero_blur: [0, 40] };
const LABELS = { daily_upload_limit: "每日上限", max_file_mb: "大小上限", hero_blur: "背景模糊度" };

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
    let session; try { session = await readSession(request, env); } catch (cause) { if (authUnavailable(cause)) return error("AUTH_STORE_UNAVAILABLE", "会话服务暂不可用，请稍后重试", 503); throw cause; }
    if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
    const body = await request.json().catch(() => ({}));
    const entries = Object.entries(body || {}).filter(([key]) => EDITABLE.has(key));
    if (!entries.length) return error("SETTING_INVALID", "没有可更新的设置项", 400);
    for (const [key, value] of entries) {
      if (key === "hero_background_url") { if (typeof value !== "string" || !validHeroUrl(value)) return error("SETTING_INVALID", "背景图地址必须是 https:// 开头的地址", 400); }
      else if (key === "accelerator_base_url") { if (typeof value !== "string" || !validAccelerator(value)) return error("SETTING_INVALID", "图片加速域名必须是 https:// 开头的域名根地址", 400); }
      else if (key === "partition_config") { if (!validPartitionConfig(value)) return error("SETTING_INVALID", "分区压缩配置格式不正确", 400); }
      else if (toNumber(value, LIMITS[key]) === null) return error("SETTING_INVALID", `${LABELS[key]}需在 ${LIMITS[key][0]} 到 ${LIMITS[key][1]} 之间`, 400);
    }
    const normalizedEntries = entries.map(([key, value]) => [key, key === "accelerator_base_url" ? value.trim().replace(/\/$/, "") : LIMITS[key] ? toNumber(value, LIMITS[key]) : value]);
    await updateState((s) => normalizedEntries.forEach(([key, value]) => setSetting(s, key, value)), env);
    invalidateHistoryCache();
    try { const store = env.IMAGE_KV; if (store?.delete) await store.delete("history_cache"); } catch {}
    return json({ ok: true, settings: { ...(await loadState(env)).settings } });
  } catch (cause) { return error("SETTINGS_FAILED", cause?.message || "设置读取失败", 502); }
}
