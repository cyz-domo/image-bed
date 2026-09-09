import sharp from "sharp";
import { readSession, authUnavailable } from "../_lib/auth.js";
import { ghApi } from "../_lib/github.js";
import { loadState, updateState, reserveDailyQuota, releaseDailyQuota, writeHistoryCache, readHistoryCache, invalidateHistoryCache } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";
import { imageUrl } from "../_lib/image-url.js";
import { validPartition } from "../_lib/partition.js";

const defaultMaxBytes = 10485760;
const defaultDailyLimit = 100;
const randomName = (extension) => `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${((globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).slice(0, 8)}.${extension}`;
// 优先 Node 原生 Buffer 编码（内存拷贝最少）；无 Buffer 环境退回分块 btoa（块长为 3 的倍数可直接拼接）
const base64 = (bytes) => { if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64"); let result = ""; const chunk = 0x7ffe; for (let index = 0; index < bytes.length; index += chunk) result += btoa(String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)))); return result; };
function magic(bytes, type) { if (type === "image/png") return bytes.slice(0, 8).every((value, i) => value === [137, 80, 78, 71, 13, 10, 26, 10][i]); if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; if (type === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a"; if (type === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"; return false; }
function sniff(bytes) { if (magic(bytes, "image/png")) return "image/png"; if (magic(bytes, "image/jpeg")) return "image/jpeg"; if (magic(bytes, "image/gif")) return "image/gif"; if (magic(bytes, "image/webp")) return "image/webp"; if (bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4"; return null; }

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  let session; try { session = await readSession(request, env); } catch (cause) { if (authUnavailable(cause)) return error("AUTH_STORE_UNAVAILABLE", "会话服务暂不可用，请稍后重试", 503); throw cause; }
  if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    // 确保状态可读（KV/状态文件），再检查当日限额
    let state = await loadState(env).catch(() => null);
    if (!state) { await updateState(() => {}, env); state = await loadState(env); }
    // 配额必须由支持原子递增的 KV 预占；不支持时拒绝上传，避免并发绕过上限
    const limit = Number(state.settings?.daily_upload_limit || env.DAILY_UPLOAD_LIMIT || defaultDailyLimit);
    const maxBytes = Math.round(Number(state.settings?.max_file_mb || env.MAX_FILE_SIZE / 1048576 || defaultMaxBytes / 1048576) * 1048576);

    let form; try { form = await request.formData(); } catch (cause) { if (String(cause.message).includes("already been read")) return error("UPLOAD_RETRY", "服务器繁忙，正在自动重试", 503); throw cause; }
    const file = form.get("file"); if (!file || typeof file.arrayBuffer !== "function") return error("FILE_REQUIRED", "请选择图片", 400); if (file.size > maxBytes) return error("FILE_TOO_LARGE", `文件不能超过 ${Math.round(maxBytes / 1048576)} MB，可在设置中调整上限`, 413);
    // 分区：images/<分区名>/年/月/文件；为空时为默认分区（须在压缩策略前解析）
    const partition = String(form.get("partition") || "").trim();
    if (partition && !validPartition(partition)) return error("PARTITION_INVALID", "分区名限 1–32 位，支持中文、字母、数字、连字符，且不能是纯数字年份", 400);
    const partitionPrefix = partition ? `${partition}/` : "";
    const source = new Uint8Array(await file.arrayBuffer()); const sniffed = sniff(source); if (!sniffed) return error("FILE_SIGNATURE_INVALID", "文件内容不是有效图片或 MP4 视频", 400);
    const isVideo = sniffed === "video/mp4";
    // 分区压缩策略：配置 compress:false 的分区保留原图（仅嗅探格式、不转码）；视频始终保留原样；缩略图始终生成
    const partitionConfig = state.settings?.partition_config || {};
    const keepOriginal = isVideo || partitionConfig[partition || "default"]?.compress === false;
    let output = source; let extension = sniffed === "image/png" ? "png" : sniffed === "image/jpeg" ? "jpg" : sniffed === "image/gif" ? "gif" : isVideo ? "mp4" : "webp"; let outputType = sniffed;
    if (!keepOriginal && sniffed !== "image/gif") { output = await sharp(source).resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer(); extension = "webp"; outputType = "image/webp"; }
    if (!keepOriginal && output.length > 5242880) return error("COMPRESSED_FILE_TOO_LARGE", "压缩后图片仍超过 5 MB，请换一张图片", 413);
    if (isVideo && output.length > 20971520) return error("FILE_TOO_LARGE", "视频不能超过 20 MB（jsDelivr 单文件分发上限）", 413);
    const reservation = await reserveDailyQuota(env, limit, session.login).catch((cause) => { if (cause?.code === "QUOTA_STORE_UNAVAILABLE") return null; throw cause; });
    if (!reservation) return error("QUOTA_STORE_UNAVAILABLE", "每日配额服务暂不可用，请稍后重试", 503);
    if (!reservation.allowed) return error("DAILY_LIMIT_REACHED", `今日上传已达上限（${limit} 张）`, 429);
    const year = new Date().getUTCFullYear(); const month = String(new Date().getUTCMonth() + 1).padStart(2, "0"); const path = `images/${partitionPrefix}${year}/${month}/${randomName(extension)}`;
    
    // 生成缩略图字节数据
    let thumbBytes = null;
    let thumbPath = null;
    if (isVideo) {
      try {
        const posterFile = form.get("poster");
        if (posterFile && typeof posterFile.arrayBuffer === "function") {
          const posterBytes = new Uint8Array(await posterFile.arrayBuffer());
          if (magic(posterBytes, "image/webp") || magic(posterBytes, "image/png") || magic(posterBytes, "image/jpeg")) {
            thumbBytes = await sharp(posterBytes).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 70, effort: 4 }).toBuffer();
            thumbPath = `.thumbnails/${partitionPrefix}${year}/${month}/${path.split("/").pop()}`;
          }
        }
      } catch { thumbBytes = null; thumbPath = null; }
    } else {
      try {
        thumbBytes = await sharp(source).resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }).webp({ quality: 70, effort: 4 }).toBuffer();
        thumbPath = `.thumbnails/${partitionPrefix}${year}/${month}/${path.split("/").pop()}`;
      } catch { thumbBytes = null; thumbPath = null; }
    }

    // 使用 Git Data API 一次性把原图和缩略图写入单个 Commit
    try {
      // 1. 创建原图 Blob
      const imgBlobRes = await ghApi(env, "git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: base64(output), encoding: "base64" })
      });
      if (!imgBlobRes.ok) throw new Error(`创建原图 Blob 失败 (${imgBlobRes.status})`);
      const imgBlobSha = (await imgBlobRes.json()).sha;

      const treeEntries = [{ path, mode: "100644", type: "blob", sha: imgBlobSha }];

      // 2. 创建缩略图 Blob（若存在）
      if (thumbBytes && thumbPath) {
        const thumbBlobRes = await ghApi(env, "git/blobs", {
          method: "POST",
          body: JSON.stringify({ content: base64(thumbBytes), encoding: "base64" })
        });
        if (thumbBlobRes.ok) {
          const thumbBlobSha = (await thumbBlobRes.json()).sha;
          treeEntries.push({ path: thumbPath, mode: "100644", type: "blob", sha: thumbBlobSha });
        } else {
          thumbPath = null; // 缩略图创建失败降级，不阻断原图上传
        }
      }

      // 3. 获取 main 最新 commit 与 base_tree
      const refRes = await ghApi(env, "git/ref/heads/main");
      if (!refRes.ok) throw new Error(`获取分支引用失败 (${refRes.status})`);
      const parentCommitSha = (await refRes.json()).object.sha;

      const commitRes = await ghApi(env, `git/commits/${parentCommitSha}`);
      if (!commitRes.ok) throw new Error(`获取 Parent Commit 失败 (${commitRes.status})`);
      const baseTreeSha = (await commitRes.json()).tree.sha;

      // 4. 创建 Tree
      const treeRes = await ghApi(env, "git/trees", {
        method: "POST",
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
      });
      if (!treeRes.ok) throw new Error(`创建 Tree 失败 (${treeRes.status})`);
      const newTreeSha = (await treeRes.json()).sha;

      // 5. 创建 Commit
      const newCommitRes = await ghApi(env, "git/commits", {
        method: "POST",
        body: JSON.stringify({ message: `chore: upload ${path.split("/").pop()}`, tree: newTreeSha, parents: [parentCommitSha] })
      });
      if (!newCommitRes.ok) throw new Error(`创建 Commit 失败 (${newCommitRes.status})`);
      const newCommitSha = (await newCommitRes.json()).sha;

      // 6. 更新 ref
      const updateRefRes = await ghApi(env, "git/refs/heads/main", {
        method: "PATCH",
        body: JSON.stringify({ sha: newCommitSha, force: false })
      });
      if (!updateRefRes.ok) throw new Error(`更新分支引用失败 (${updateRefRes.status})`);
    } catch (cause) {
      await releaseDailyQuota(env, reservation).catch(() => {});
      throw cause;
    }
    await updateState((s) => { s.owners = { ...s.owners, [path]: session.login }; s.daily = { ...s.daily, [session.login]: { key: new Date().toISOString().slice(0, 10), count: reservation.used } }; }, env).catch((cause) => { console.warn("每日配额展示状态同步失败", cause); });
    // 刷新历史缓存：把新图插到列表头，失败则忽略（下次全量拉取）
    invalidateHistoryCache();
    await (async () => { try { const cached = await readHistoryCache(env); if (!cached || Date.now() - cached.savedAt >= 600000 || !Array.isArray(cached.items)) return; const item = { path, partition, owner: session.login, type: isVideo ? "video" : "image", url: imageUrl(env, path, state.settings), ...(thumbPath ? { thumb: imageUrl(env, thumbPath, state.settings) } : {}) }; await writeHistoryCache(env, [item, ...cached.items.filter((entry) => entry.path !== path)]); } catch {} })();
    const url = imageUrl(env, path, state.settings);
    return json({ path, url, markdown: `![image](${url})`, type: isVideo ? "video" : "image", ...(thumbPath ? { thumb: imageUrl(env, thumbPath, state.settings) } : {}), content_type: outputType, bytes: output.length, compressed: !keepOriginal && sniffed !== "image/gif", daily_remaining: reservation.remaining });
  } catch (cause) { return error("UPLOAD_FAILED", cause.message || "上传失败", 502); }
}
