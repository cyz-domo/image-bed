import sharp from "sharp";
import { installationToken, readSession } from "../_lib/auth.js";
import { error, json } from "../_lib/http.js";

const allowed = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"]]);
const defaultMaxBytes = 10485760;
const randomName = (extension) => `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
const base64 = (bytes) => { let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); };
function magic(bytes, type) { if (type === "image/png") return bytes.slice(0, 8).every((value, i) => value === [137, 80, 78, 71, 13, 10, 26, 10][i]); if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; if (type === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a"; if (type === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"; return false; }
async function putFile(path, data, message, env) { const token = await installationToken(env); const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`, { method: "PUT", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }, body: JSON.stringify({ message, content: base64(new Uint8Array(data)), branch: "main" }) }); if (!response.ok) throw new Error(`GitHub 写入失败 (${response.status})`); }

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  const session = await readSession(request, env); if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    const form = await request.formData(); const file = form.get("file"); if (!file || typeof file.arrayBuffer !== "function") return error("FILE_REQUIRED", "请选择图片", 400); const limit = Number(env.MAX_FILE_SIZE || defaultMaxBytes); if (file.size > limit) return error("FILE_TOO_LARGE", "图片不能超过 10 MB", 413);
    const type = file.type.toLowerCase(); if (!allowed.has(type)) return error("FILE_TYPE_NOT_ALLOWED", "只支持 PNG、JPG、GIF 和 WebP", 400);
    const source = new Uint8Array(await file.arrayBuffer()); if (!magic(source, type)) return error("FILE_SIGNATURE_INVALID", "文件内容不是有效图片", 400);
    let output = source; let extension = allowed.get(type); let outputType = type;
    if (type !== "image/gif") { output = await sharp(source).resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer(); extension = "webp"; outputType = "image/webp"; }
    if (output.length > 5242880) return error("COMPRESSED_FILE_TOO_LARGE", "压缩后图片仍超过 5 MB，请换一张图片", 413);
    const year = new Date().getUTCFullYear(); const month = String(new Date().getUTCMonth() + 1).padStart(2, "0"); const path = `images/${year}/${month}/${randomName(extension)}`;
    await putFile(path, output, `chore: upload ${path.split("/").pop()}`, env);
    const url = `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@main/${path}`;
    return json({ path, url, markdown: `![image](${url})`, content_type: outputType, bytes: output.length });
  } catch (cause) { return error("UPLOAD_FAILED", cause.message || "上传失败", 502); }
}
