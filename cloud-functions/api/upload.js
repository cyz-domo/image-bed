import sharp from "sharp";
import { readSession, authUnavailable } from "../_lib/auth.js";
import { ghApi } from "../_lib/github.js";
import { loadState, updateState, reserveDailyQuota, releaseDailyQuota, writeHistoryCache, readHistoryCache, invalidateHistoryCache } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";
import { imageUrl } from "../_lib/image-url.js";
import { validPartition } from "../_lib/partition.js";

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
const defaultMaxBytes = 10485760;
const defaultDailyLimit = 100;
const randomName = (extension) => `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${((globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).slice(0, 8)}.${extension}`;
// 优先 Node 原生 Buffer 编码（内存拷贝最少）；无 Buffer 环境退回分块 btoa（块长为 3 的倍数可直接拼接）
const base64 = (bytes) => { if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64"); let result = ""; const chunk = 0x7ffe; for (let index = 0; index < bytes.length; index += chunk) result += btoa(String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)))); return result; };
function magic(bytes, type) { if (type === "image/png") return bytes.slice(0, 8).every((value, i) => value === [137, 80, 78, 71, 13, 10, 26, 10][i]); if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; if (type === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a"; if (type === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"; return false; }
function sniff(bytes) { if (magic(bytes, "image/png")) return "image/png"; if (magic(bytes, "image/jpeg")) return "image/jpeg"; if (magic(bytes, "image/gif")) return "image/gif"; if (magic(bytes, "image/webp")) return "image/webp"; if (bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4"; return null; }

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  try {
    let session; try { session = await readSession(request, env); } catch (cause) { if (authUnavailable(cause)) return error("AUTH_STORE_UNAVAILABLE", "会话服务暂不可用，请稍后重试", 503); throw cause; }
    if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);

    // 尽早读取请求体，避免在等待外部网络调用时请求流超时或被提前消费
    let form;
    try {
      form = await request.formData();
    } catch (cause) {
      console.error("[Upload] request.formData() 解析异常:", cause);
      if (String(cause?.message || cause).includes("already been read")) {
        return error("UPLOAD_RETRY", "服务器繁忙，正在自动重试", 503);
      }
      return error("BAD_REQUEST", `请求解析失败: ${cause?.message || "请重试"}`, 400);
    }

    // 获取支持多文件数组：form.getAll("files") 或 form.getAll("file")
    const rawFiles = [...form.getAll("files"), ...form.getAll("file")].filter(f => f && typeof f.arrayBuffer === "function");
    if (!rawFiles.length) return error("FILE_REQUIRED", "请选择图片", 400);

    const config = runtimeEnv(env);
    const store = (config.IMAGE_KV && typeof config.IMAGE_KV.get === "function") ? config.IMAGE_KV : null;
    // 确保状态可读（KV/状态文件），再检查当日限额
    let state = await loadState(env).catch(() => null);
    if (!state) { await updateState(() => {}, env); state = await loadState(env); }
    // 配额必须由支持原子递增的 KV 预占；不支持时拒绝上传，避免并发绕过上限
    const limit = Number(state.settings?.daily_upload_limit || config.DAILY_UPLOAD_LIMIT || defaultDailyLimit);
    const maxBytes = Math.round(Number(state.settings?.max_file_mb || config.MAX_FILE_SIZE / 1048576 || defaultMaxBytes / 1048576) * 1048576);

    const partition = String(form.get("partition") || "").trim();
    if (partition && !validPartition(partition)) return error("PARTITION_INVALID", "分区名限 1–32 位，支持中文、字母、数字、连字符，且不能是纯数字年份", 400);
    const partitionPrefix = partition ? `${partition}/` : "";
    const partitionConfig = state.settings?.partition_config || {};
    const year = new Date().getUTCFullYear();
    const month = String(new Date().getUTCMonth() + 1).padStart(2, "0");

    // 1. 预占每日配额（尝试为这批文件申请配额）
    const reservation = await reserveDailyQuota(env, limit, session.login).catch((cause) => { if (cause?.code === "QUOTA_STORE_UNAVAILABLE") return null; throw cause; });
    if (!reservation) return error("QUOTA_STORE_UNAVAILABLE", "每日配额服务暂不可用，请稍后重试", 503);
    if (!reservation.allowed) return error("DAILY_LIMIT_REACHED", `今日上传已达上限（${limit} 张）`, 429);

    // 2. 依次在内存中压缩与生成各文件的原图和缩略图 Blob
    const processedFiles = [];
    const treeEntries = [];

    for (let idx = 0; idx < rawFiles.length; idx += 1) {
      const file = rawFiles[idx];
      if (file.size > maxBytes) return error("FILE_TOO_LARGE", `文件 [${file.name}] 不能超过 ${Math.round(maxBytes / 1048576)} MB`, 413);

      const source = new Uint8Array(await file.arrayBuffer());
      const sniffed = sniff(source);
      if (!sniffed) return error("FILE_SIGNATURE_INVALID", `文件 [${file.name}] 内容不是有效图片或 MP4 视频`, 400);

      const isVideo = sniffed === "video/mp4";
      const keepOriginal = isVideo || partitionConfig[partition || "default"]?.compress === false;

      let output = source;
      let extension = sniffed === "image/png" ? "png" : sniffed === "image/jpeg" ? "jpg" : sniffed === "image/gif" ? "gif" : isVideo ? "mp4" : "webp";
      let outputType = sniffed;

      if (!keepOriginal && sniffed !== "image/gif" && sniffed !== "image/webp") {
        output = await sharp(source).resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).webp({ quality: 82, effort: 2 }).toBuffer();
        extension = "webp";
        outputType = "image/webp";
      }
      if (!keepOriginal && output.length > 5242880) return error("COMPRESSED_FILE_TOO_LARGE", `图片 [${file.name}] 压缩后仍超过 5 MB`, 413);
      if (isVideo && output.length > 20971520) return error("FILE_TOO_LARGE", `视频 [${file.name}] 不能超过 20 MB`, 413);

      const path = `images/${partitionPrefix}${year}/${month}/${randomName(extension)}`;

      // 缩略图（单通道轻量压缩，effort: 2 降低函数执行耗时）
      let thumbBytes = null;
      let thumbPath = null;
      if (isVideo) {
        try {
          const posterFile = form.getAll("poster")[idx] || form.get("poster");
          if (posterFile && typeof posterFile.arrayBuffer === "function") {
            const posterBytes = new Uint8Array(await posterFile.arrayBuffer());
            if (magic(posterBytes, "image/webp") || magic(posterBytes, "image/png") || magic(posterBytes, "image/jpeg")) {
              thumbBytes = await sharp(posterBytes).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 70, effort: 2 }).toBuffer();
              thumbPath = `.thumbnails/${partitionPrefix}${year}/${month}/${path.split("/").pop()}`;
            }
          }
        } catch { thumbBytes = null; thumbPath = null; }
      } else {
        try {
          thumbBytes = await sharp(source).resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }).webp({ quality: 65, effort: 2 }).toBuffer();
          thumbPath = `.thumbnails/${partitionPrefix}${year}/${month}/${path.split("/").pop()}`;
        } catch { thumbBytes = null; thumbPath = null; }
      }

      processedFiles.push({ path, thumbPath, isVideo, outputType, bytes: output.length, compressed: !keepOriginal && sniffed !== "image/gif", output, thumbBytes });
    }

    // 3. 将所有文件通过 Git Data API 打包写入（并发执行网络 I/O，消除超时风险）
    try {
      // 3.1 准备 fallback 模式下的 state.json Blob 任务
      let stateBlobTask = null;
      if (!store) {
        const updatedState = { ...state };
        updatedState.owners = updatedState.owners || {};
        updatedState.daily = updatedState.daily || {};
        for (const item of processedFiles) {
          updatedState.owners[item.path] = session.login;
        }
        updatedState.daily[session.login] = { key: new Date().toISOString().slice(0, 10), count: reservation.used };

        const stateJsonStr = JSON.stringify(updatedState);
        stateBlobTask = ghApi(env, "git/blobs", {
          method: "POST",
          body: JSON.stringify({ content: base64(new TextEncoder().encode(stateJsonStr)), encoding: "base64" })
        }).then(async (res) => {
          if (!res.ok) throw new Error(`创建 state.json Blob 失败 (${res.status})`);
          const sha = (await res.json()).sha;
          return { path: ".state/state.json", mode: "100644", type: "blob", sha };
        });
      }

      // 3.2 准备获取 Parent Commit 和 base_tree 任务（与 Blob 并行发出，省去往返耗时）
      const parentTask = (async () => {
        const refRes = await ghApi(env, "git/ref/heads/main");
        if (!refRes.ok) throw new Error(`获取分支引用失败 (${refRes.status})`);
        const parentCommitSha = (await refRes.json()).object.sha;

        const commitRes = await ghApi(env, `git/commits/${parentCommitSha}`);
        if (!commitRes.ok) throw new Error(`获取 Parent Commit 失败 (${commitRes.status})`);
        const baseTreeSha = (await commitRes.json()).tree.sha;
        return { parentCommitSha, baseTreeSha };
      })();

      // 3.3 准备所有原图与缩略图 Blob 上传任务
      const blobTasks = [];
      for (const item of processedFiles) {
        blobTasks.push((async () => {
          const imgBlobRes = await ghApi(env, "git/blobs", {
            method: "POST",
            body: JSON.stringify({ content: base64(item.output), encoding: "base64" })
          });
          if (!imgBlobRes.ok) throw new Error(`创建原图 Blob 失败 (${imgBlobRes.status})`);
          const imgBlobSha = (await imgBlobRes.json()).sha;
          return { path: item.path, mode: "100644", type: "blob", sha: imgBlobSha };
        })());

        if (item.thumbBytes && item.thumbPath) {
          blobTasks.push((async () => {
            const thumbBlobRes = await ghApi(env, "git/blobs", {
              method: "POST",
              body: JSON.stringify({ content: base64(item.thumbBytes), encoding: "base64" })
            });
            if (thumbBlobRes.ok) {
              const thumbBlobSha = (await thumbBlobRes.json()).sha;
              return { path: item.thumbPath, mode: "100644", type: "blob", sha: thumbBlobSha };
            }
            item.thumbPath = null;
            return null;
          })());
        }
      }

      // 并发执行：Parent Commit 获取 + 所有原图 Blob + 所有缩略图 Blob + state.json Blob
      const [parentInfo, ...resolvedEntries] = await Promise.all([
        parentTask,
        ...blobTasks,
        ...(stateBlobTask ? [stateBlobTask] : [])
      ]);

      for (const entry of resolvedEntries) {
        if (entry) treeEntries.push(entry);
      }

      // 3.4 创建包含全部文件及 state.json 的新 Git Tree
      const treeRes = await ghApi(env, "git/trees", {
        method: "POST",
        body: JSON.stringify({ base_tree: parentInfo.baseTreeSha, tree: treeEntries })
      });
      if (!treeRes.ok) throw new Error(`创建 Tree 失败 (${treeRes.status})`);
      const newTreeSha = (await treeRes.json()).sha;

      // 3.5 创建唯一 Commit
      const commitMsg = processedFiles.length === 1 ? `chore: upload ${processedFiles[0].path.split("/").pop()}` : `chore: upload ${processedFiles.length} images`;
      const newCommitRes = await ghApi(env, "git/commits", {
        method: "POST",
        body: JSON.stringify({ message: commitMsg, tree: newTreeSha, parents: [parentInfo.parentCommitSha] })
      });
      if (!newCommitRes.ok) throw new Error(`创建 Commit 失败 (${newCommitRes.status})`);
      const newCommitSha = (await newCommitRes.json()).sha;

      // 3.6 更新 ref 指针
      const updateRefRes = await ghApi(env, "git/refs/heads/main", {
        method: "PATCH",
        body: JSON.stringify({ sha: newCommitSha, force: false })
      });
      if (!updateRefRes.ok) throw new Error(`更新分支引用失败 (${updateRefRes.status})`);
    } catch (cause) {
      await releaseDailyQuota(env, reservation).catch(() => {});
      throw cause;
    }

    // 4. KV 存在时同步 KV 状态；无 KV 时状态已合并在 Git Tree 提交中
    if (store) {
      await updateState((s) => {
        s.owners = s.owners || {};
        for (const item of processedFiles) s.owners[item.path] = session.login;
        s.daily = { ...s.daily, [session.login]: { key: new Date().toISOString().slice(0, 10), count: reservation.used } };
      }, env).catch((cause) => { console.warn("每日配额展示状态同步失败", cause); });
    }

    // 5. 刷新历史缓存并构造结果返回
    invalidateHistoryCache();
    const results = processedFiles.map((item) => {
      const url = imageUrl(env, item.path, state.settings);
      const thumbUrl = item.thumbPath ? imageUrl(env, item.thumbPath, state.settings) : null;
      return {
        path: item.path,
        url,
        markdown: `![image](${url})`,
        type: item.isVideo ? "video" : "image",
        ...(thumbUrl ? { thumb: thumbUrl } : {}),
        content_type: item.outputType,
        bytes: item.bytes,
        compressed: item.compressed,
        daily_remaining: reservation.remaining
      };
    });

    // 兼容单文件和多文件返回格式
    if (rawFiles.length === 1) {
      return json(results[0]);
    }
    return json({ items: results });
  } catch (cause) {
    console.error("[Upload] 上传发生异常:", cause);
    return error("UPLOAD_FAILED", cause?.message || "上传失败", 502);
  }
}
