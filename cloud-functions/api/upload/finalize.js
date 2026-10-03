// 直传登记：浏览器直传 GitHub 完成后，校验文件存在、登记仓库索引并写入历史缓存（视频与大体积图片均走此流程）
import { readSession, authUnavailable } from "../../_lib/auth.js";
import { ghApi } from "../../_lib/github.js";
import { loadState, updateState, writeHistoryCache, readHistoryCache, invalidateHistoryCache } from "../../_lib/state.js";
import { upsertRecords, writeIndex } from "../../_lib/history-index.js";
import { error, json } from "../../_lib/http.js";
import { imageUrl } from "../../_lib/image-url.js";
import { partitionOf, validPartition } from "../../_lib/partition.js";

const encodePath = (path) => encodeURIComponent(path).replace(/%2F/g, "/");
const uploadPath = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/[\w.-]+\.(?:png|jpe?g|gif|webp|mp4)$/i;
const thumbPathRe = /^\.thumbnails\/(?:[^/]+\/)?\d{4}\/\d{2}\/[\w.-]+\.(?:png|jpe?g|gif|webp|mp4)$/i;
const fileTypeOf = (path) => (/\.mp4$/i.test(path) ? "video" : "image");
// commit sha 只接受 40 位十六进制：钉到 commit 的地址可被 CDN 长缓存
const commitShaOf = (value) => (/^[0-9a-f]{40}$/.test(String(value || "").toLowerCase()) ? String(value).toLowerCase() : null);

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  let session; try { session = await readSession(request, env); } catch (cause) { if (authUnavailable(cause)) return error("AUTH_STORE_UNAVAILABLE", "会话服务暂不可用，请稍后重试", 503); throw cause; }
  if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    const body = await request.json().catch(() => ({}));
    const path = typeof body.path === "string" ? body.path : "";
    const partition = String(body.partition || "").trim();
    if (partition && !validPartition(partition)) return error("PARTITION_INVALID", "分区名不合法", 400);
    if (!uploadPath.test(path)) return error("PATH_INVALID", "文件路径不合法", 400);
    if (partitionOf(path) !== partition) return error("PATH_INVALID", "路径与分区不一致", 400);
    const bytes = Number(body.bytes); if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 20971520) return error("BYTES_INVALID", "文件不能超过 20 MB（jsDelivr 单文件分发上限）", 400);
    const thumbPath = typeof body.thumb_path === "string" && thumbPathRe.test(body.thumb_path) ? body.thumb_path : null;
    const commit = commitShaOf(body.commit_sha);
    const thumbCommit = commitShaOf(body.thumb_commit_sha) || commit;
    const fileType = fileTypeOf(path);
    // 确认直传的文件确实存在（元数据请求，不含文件内容）
    const head = await ghApi(env, `contents/${encodePath(path)}?ref=main`);
    if (!head.ok) return error("UPLOAD_NOT_FOUND", "未找到直传的文件", 400);
    const state = await loadState(env);
    await updateState((s) => { s.owners = { ...s.owners, [path]: session.login }; }, env).catch(() => {});
    invalidateHistoryCache();
    const record = upsertRecords([], [{ path, thumbPath, bytes, commit, thumbCommit }]);
    await writeIndex(env, record, `chore: index ${path.split("/").pop()}`).then((written) => { if (!written) console.warn("[Finalize] 图库索引更新失败"); }).catch((cause) => console.warn("[Finalize] 图库索引写入异常:", cause.message));
    await (async () => { try { const cached = await readHistoryCache(env); if (!cached || Date.now() - cached.savedAt >= 600000 || !Array.isArray(cached.items)) return; const item = { path, partition, owner: session.login, type: fileType, bytes, ...(commit ? { commit } : {}), ...(thumbPath ? { thumb: thumbPath, thumbCommit } : {}) }; await writeHistoryCache(env, [item, ...cached.items.filter((entry) => entry.path !== path)]); } catch {} })();
    const url = imageUrl(env, path, state.settings, commit);
    return json({ path, url, markdown: `![${fileType}](${url})`, type: fileType, bytes, ...(thumbPath ? { thumb: imageUrl(env, thumbPath, state.settings, thumbCommit) } : {}) });
  } catch (cause) { return error("FINALIZE_FAILED", cause?.message || "上传登记失败", 502); }
}
