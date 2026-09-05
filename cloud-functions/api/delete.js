import { readSession, authUnavailable } from "../_lib/auth.js";
import { ghApi } from "../_lib/github.js";
import { readHistoryCache, writeHistoryCache, updateState, invalidateHistoryCache } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

// 只允许删除 images/ 目录下的图片与视频文件（含分区前缀），防止路径穿越或误删其他内容
const imagePath = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/[\w一-鿿.-]+\.(?:png|jpe?g|gif|webp|mp4)$/i;
const encodePath = (path) => encodeURIComponent(path).replace(/%2F/g, "/");
const MAX_BATCH = 20;

// 删除单张：串行执行；409 说明分支 sha 已变化（并发提交竞争），重取 sha 重试一次
async function deleteOne(env, path) {
  // 图片与其缩略图一起删（不存在则静默跳过）
  const targets = [path, `.thumbnails/${path.slice("images/".length)}`];
  for (const target of targets) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const head = await ghApi(env, `contents/${encodePath(target)}?ref=main`);
        if (head.status === 404) break; // 缩略图可能不存在，正常
        if (!head.ok) return { path, ok: false, message: `读取失败 (${head.status})` };
        const sha = (await head.json()).sha;
        const del = await ghApi(env, `contents/${encodePath(target)}`, { method: "DELETE", body: JSON.stringify({ message: `chore: delete ${target}`, sha, branch: "main" }) });
        if (del.ok || del.status === 404) break;
        if (del.status !== 409) return { path, ok: false, message: `删除失败 (${del.status})` };
        // 409：sha 过期，循环重取
      } catch (cause) { return { path, ok: false, message: cause.message || "删除失败" }; }
    }
  }
  return { path, ok: true };
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  let session; try { session = await readSession(request, env); } catch (cause) { if (authUnavailable(cause)) return error("AUTH_STORE_UNAVAILABLE", "会话服务暂不可用，请稍后重试", 503); throw cause; }
  if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    const body = await request.json().catch(() => ({}));
    // 兼容单个 path 与批量 paths
    const paths = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
    if (!paths.length || paths.length > MAX_BATCH) return error("PATH_INVALID", `一次最多删除 ${MAX_BATCH} 张`, 400);
    for (const path of paths) if (typeof path !== "string" || !imagePath.test(path)) return error("PATH_INVALID", `图片路径不合法: ${path}`, 400);

    // GitHub 分支引用串行更新，必须逐张删，并发会产生 409 sha 冲突
    const results = [];
    for (const path of paths) results.push(await deleteOne(env, path));

    const okPaths = results.filter((r) => r.ok).map((r) => r.path);
    if (okPaths.length) {
      try { const cached = await readHistoryCache(env); if (cached) await writeHistoryCache(env, cached.items.filter((item) => !okPaths.includes(item.path))); } catch {}
      invalidateHistoryCache();
      try { await updateState((s) => { for (const path of okPaths) delete s.links?.[path]; }, env); } catch {}
    }
    const failed = results.filter((r) => !r.ok);
    return json({ ok: failed.length === 0, deleted: okPaths, failed, failed_count: failed.length });
  } catch (cause) { return error("DELETE_FAILED", cause.message || "删除失败", 502); }
}
