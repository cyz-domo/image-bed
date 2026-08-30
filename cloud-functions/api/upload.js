import sharp from "sharp";
import { readSession, authUnavailable } from "../_lib/auth.js";
import { ghApi } from "../_lib/github.js";
import { loadState, updateState, reserveDailyQuota, releaseDailyQuota, writeHistoryCache, readHistoryCache, invalidateHistoryCache } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";
import { imageUrl } from "../_lib/image-url.js";

const defaultMaxBytes = 10485760;
const defaultDailyLimit = 100;
const randomName = (extension) => `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
const base64 = (bytes) => { let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); };
function magic(bytes, type) { if (type === "image/png") return bytes.slice(0, 8).every((value, i) => value === [137, 80, 78, 71, 13, 10, 26, 10][i]); if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; if (type === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a"; if (type === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"; return false; }
function sniff(bytes) { if (magic(bytes, "image/png")) return "image/png"; if (magic(bytes, "image/jpeg")) return "image/jpeg"; if (magic(bytes, "image/gif")) return "image/gif"; if (magic(bytes, "image/webp")) return "image/webp"; return null; }

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
    const file = form.get("file"); if (!file || typeof file.arrayBuffer !== "function") return error("FILE_REQUIRED", "请选择图片", 400); if (file.size > maxBytes) return error("FILE_TOO_LARGE", `图片不能超过 ${Math.round(maxBytes / 1048576)} MB`, 413);
    const source = new Uint8Array(await file.arrayBuffer()); const sniffed = sniff(source); if (!sniffed) return error("FILE_SIGNATURE_INVALID", "文件内容不是有效图片（支持 PNG、JPG、GIF、WebP）", 400);
    let output = source; let extension = sniffed === "image/png" ? "png" : sniffed === "image/jpeg" ? "jpg" : sniffed === "image/gif" ? "gif" : "webp"; let outputType = sniffed;
    if (sniffed !== "image/gif") { output = await sharp(source).resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer(); extension = "webp"; outputType = "image/webp"; }
    if (output.length > 5242880) return error("COMPRESSED_FILE_TOO_LARGE", "压缩后图片仍超过 5 MB，请换一张图片", 413);
    const reservation = await reserveDailyQuota(env, limit).catch((cause) => { if (cause?.code === "QUOTA_STORE_UNAVAILABLE") return null; throw cause; });
    if (!reservation) return error("QUOTA_STORE_UNAVAILABLE", "每日配额服务暂不可用，请稍后重试", 503);
    if (!reservation.allowed) return error("DAILY_LIMIT_REACHED", `今日上传已达上限（${limit} 张）`, 429);
    const year = new Date().getUTCFullYear(); const month = String(new Date().getUTCMonth() + 1).padStart(2, "0"); const path = `images/${year}/${month}/${randomName(extension)}`;
    try {
      await ghApi(env, `contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `chore: upload ${path.split("/").pop()}`, content: base64(new Uint8Array(output)), branch: "main" }) }).then((response) => { if (!response.ok) throw new Error(`GitHub 写入失败 (${response.status})`); });
    } catch (cause) { await releaseDailyQuota(env, reservation).catch(() => {}); throw cause; }
    // 缩略图：长边 320、质量 70 的 WebP，存 .thumbnails/ 同构路径；失败不阻断上传
    let thumbPath = null;
    try {
      const thumb = await sharp(source).resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }).webp({ quality: 70, effort: 4 }).toBuffer();
      thumbPath = `.thumbnails/${year}/${month}/${path.split("/").pop()}`;
      await ghApi(env, `contents/${thumbPath}`, { method: "PUT", body: JSON.stringify({ message: `chore: thumb ${path.split("/").pop()}`, content: base64(new Uint8Array(thumb)), branch: "main" }) }).then((response) => { if (!response.ok) throw new Error(String(response.status)); });
    } catch { thumbPath = null; }
    await updateState((s) => { s.daily = { key: new Date().toISOString().slice(0, 10), count: reservation.used }; }, env).catch((cause) => { console.warn("每日配额展示状态同步失败", cause); });
    // 刷新历史缓存：把新图插到列表头，失败则忽略（下次全量拉取）
    invalidateHistoryCache();
    await (async () => { try { const cached = await readHistoryCache(env); if (!cached || Date.now() - cached.savedAt >= 600000 || !Array.isArray(cached.items)) return; const item = { path, url: imageUrl(env, path, state.settings), ...(thumbPath ? { thumb: imageUrl(env, thumbPath, state.settings) } : {}) }; await writeHistoryCache(env, [item, ...cached.items.filter((entry) => entry.path !== path)]); } catch {} })();
    const url = imageUrl(env, path, state.settings);
    return json({ path, url, markdown: `![image](${url})`, content_type: outputType, bytes: output.length, daily_remaining: reservation.remaining });
  } catch (cause) { return error("UPLOAD_FAILED", cause.message || "上传失败", 502); }
}
