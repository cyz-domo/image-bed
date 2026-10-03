// 缩略图体检与补齐登记：管理员用它找出索引里没有缩略图的存量图片（t!=1），
// 缩略图本身由浏览器生成后经这里登记进索引——边缘函数不必下载几 MB 原图，也就不会撞函数时限。
import { readSession, isAdminSession } from "../../_lib/auth.js";
import { ghApi, installationToken } from "../../_lib/github.js";
import { loadState, invalidateHistoryCache } from "../../_lib/state.js";
import { readIndex, upsertRecords, writeIndex, thumbPathOf } from "../../_lib/history-index.js";
import { imageUrl } from "../../_lib/image-url.js";
import { error, json } from "../../_lib/http.js";
import { partitionOf } from "../../_lib/partition.js";

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
const encodePath = (path) => encodeURIComponent(path).replace(/%2F/g, "/");
const uploadPath = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/[\w.-]+\.(?:png|jpe?g|gif|webp)$/i;
const commitShaOf = (value) => (/^[0-9a-f]{40}$/.test(String(value || "").toLowerCase()) ? String(value).toLowerCase() : null);
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

async function scan(env, state) {
  const indexed = await readIndex(env).catch(() => null);
  if (!indexed) throw fail("INDEX_MISSING", "图库索引还没建好，请先打开一次图片库", 409);
  const missing = indexed.records.filter((record) => record.t !== 1 && uploadPath.test(record.p)).map((record) => ({
    path: record.p,
    partition: partitionOf(record.p),
    type: "image",
    thumb: thumbPathOf(record.p),
    bytes: Number.isSafeInteger(record.s) ? record.s : null,
    url: imageUrl(env, record.p, state.settings, record.c),
  }));
  return { total: indexed.records.length, missing, missingBytes: missing.reduce((sum, item) => sum + (item.bytes || 0), 0) };
}

async function register(env, body, state) {
  const path = typeof body.path === "string" ? body.path : "";
  const thumbPath = typeof body.thumb === "string" ? body.thumb : "";
  if (!uploadPath.test(path)) throw fail("PATH_INVALID", "文件路径不合法", 400);
  if (thumbPath !== thumbPathOf(path)) throw fail("THUMB_PATH_INVALID", "缩略图路径与图片不一致", 400);
  const bytes = Number(body.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 20971520) throw fail("BYTES_INVALID", "文件大小不合法", 400);
  const thumbCommit = commitShaOf(body.thumb_commit);
  if (!thumbCommit) throw fail("THUMB_COMMIT_INVALID", "缺少缩略图提交号", 400);
  // 只登记浏览器确实提交成功的缩略图，避免索引指向不存在的文件
  const head = await ghApi(env, `contents/${encodePath(thumbPath)}?ref=main`);
  if (!head.ok) throw fail("THUMB_NOT_FOUND", "仓库里找不到该缩略图", 400);
  const indexed = await readIndex(env).catch(() => null);
  const existing = (indexed?.records || []).find((record) => record.p === path) || {};
  const records = upsertRecords(indexed?.records || [], [{ path, thumbPath, bytes, commit: existing.c, thumbCommit }]);
  const written = await writeIndex(env, records, `chore: index thumb ${path.split("/").pop()}`);
  invalidateHistoryCache();
  if (!written) throw fail("INDEX_WRITE_FAILED", "缩略图已提交，但索引更新失败，请稍后重试", 502);
  return { path, url: imageUrl(env, path, state.settings, existing.c), thumb: imageUrl(env, thumbPath, state.settings, thumbCommit) };
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  const session = await readSession(request, env).catch(() => null);
  if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  if (!isAdminSession(session, env)) return error("FORBIDDEN", "仅管理员可检查缩略图", 403);
  const body = await request.json().catch(() => ({}));
  try {
    const state = await loadState(env);
    if (body.action === "register") return json(await register(env, body, state));
    const result = await scan(env, state);
    // 补齐时浏览器要直接把缩略图 PUT 到仓库，令牌随扫描结果一次发完，避免逐张再取
    if (body.with_token) {
      const config = runtimeEnv(env);
      Object.assign(result, { token: await installationToken(env), owner: config.GITHUB_OWNER, repo: config.GITHUB_REPO });
    }
    return json(result);
  } catch (cause) {
    if (cause?.code && cause.status) return error(cause.code, cause.message, cause.status);
    return error("THUMBNAILS_FAILED", cause?.message || "缩略图检查失败", 502);
  }
}
