import sharp from "sharp";
import { installationToken, readSession } from "../_lib/auth.js";
import { ghApi } from "../_lib/github.js";
import { loadState, updateState, bumpDailyCount, freshState } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

const defaultMaxBytes = 10485760;
const defaultDailyLimit = 100;
const randomName = (extension) => `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
const base64 = (bytes) => { let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); };
function magic(bytes, type) { if (type === "image/png") return bytes.slice(0, 8).every((value, i) => value === [137, 80, 78, 71, 13, 10, 26, 10][i]); if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; if (type === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a"; if (type === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"; return false; }
function sniff(bytes) { if (magic(bytes, "image/png")) return "image/png"; if (magic(bytes, "image/jpeg")) return "image/jpeg"; if (magic(bytes, "image/gif")) return "image/gif"; if (magic(bytes, "image/webp")) return "image/webp"; return null; }

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  const session = await readSession(request, env); if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    // 确保状态文件存在（首次上传时初始化），再检查当日限额
    let state = await loadState().catch(() => null);
    if (!state) await updateState(() => {});
    const limit = Number(env.DAILY_UPLOAD_LIMIT || defaultDailyLimit);
    const used = state?.daily?.key === new Date().toISOString().slice(0, 10) ? state.daily.count : 0;
    if (used >= limit) return error("DAILY_LIMIT_REACHED", `今日上传已达上限（${limit} 张）`, 429);
    const remaining = limit - used;

    const form = await request.formData(); const file = form.get("file"); if (!file || typeof file.arrayBuffer !== "function") return error("FILE_REQUIRED", "请选择图片", 400); if (file.size > Number(env.MAX_FILE_SIZE || defaultMaxBytes)) return error("FILE_TOO_LARGE", "图片不能超过 10 MB", 413);
    const source = new Uint8Array(await file.arrayBuffer()); const sniffed = sniff(source); if (!sniffed) return error("FILE_SIGNATURE_INVALID", "文件内容不是有效图片（支持 PNG、JPG、GIF、WebP）", 400);
    let output = source; let extension = sniffed === "image/png" ? "png" : sniffed === "image/jpeg" ? "jpg" : sniffed === "image/gif" ? "gif" : "webp"; let outputType = sniffed;
    if (sniffed !== "image/gif") { output = await sharp(source).resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer(); extension = "webp"; outputType = "image/webp"; }
    if (output.length > 5242880) return error("COMPRESSED_FILE_TOO_LARGE", "压缩后图片仍超过 5 MB，请换一张图片", 413);
    const year = new Date().getUTCFullYear(); const month = String(new Date().getUTCMonth() + 1).padStart(2, "0"); const path = `images/${year}/${month}/${randomName(extension)}`;
    await ghApi(env, `contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `chore: upload ${path.split("/").pop()}`, content: base64(new Uint8Array(output)), branch: "main" }) }).then((response) => { if (!response.ok) throw new Error(`GitHub 写入失败 (${response.status})`); });
    await updateState((s) => bumpDailyCount(s)).catch(() => {}); // 计数失败不阻断上传结果
    const url = `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@main/${path}`;
    return json({ path, url, markdown: `![image](${url})`, content_type: outputType, bytes: output.length, daily_remaining: remaining - 1 });
  } catch (cause) { return error("UPLOAD_FAILED", cause.message || "上传失败", 502); }
}
