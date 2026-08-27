import { readSession } from "../_lib/auth.js";
import { loadState, updateState } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

const imagePath = /^images\/\d{4}\/\d{2}\/[\w一-鿿.-]+\.(?:png|jpe?g|gif|webp)$/i;

export async function onRequest({ request, env }) {
  const session = await readSession(request, env); if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    if (request.method === "GET") return json({ links: (await loadState(env)).links || {} });
    if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 GET 和 POST", 405);
    const body = await request.json().catch(() => ({}));
    const path = body?.path;
    if (typeof path !== "string" || !imagePath.test(path)) return error("PATH_INVALID", "图片路径不合法", 400);
    await updateState((s) => { s.links = s.links || {}; const record = s.links[path] || { count: 0 }; record.count += 1; record.last_at = new Date().toISOString(); s.links[path] = record; }, env);
    return json({ ok: true });
  } catch (cause) { return error("LINKS_FAILED", cause?.message || "记录失败", 502); }
}
