import { readSession } from "../_lib/auth.js";
import { ghApi } from "../_lib/github.js";
import { error, json } from "../_lib/http.js";

// 只允许删除 images/ 目录下的图片文件，防止路径穿越或误删其他内容
const imagePath = /^images\/\d{4}\/\d{2}\/[\w一-鿿.-]+\.(?:png|jpe?g|gif|webp)$/i;

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  const session = await readSession(request, env); if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    const body = await request.json().catch(() => ({})); const path = body.path;
    if (!path || !imagePath.test(path)) return error("PATH_INVALID", "图片路径不合法", 400);
    const head = await ghApi(env, `contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=main`);
    if (head.status === 404) return error("NOT_FOUND", "图片不存在或已删除", 404);
    if (!head.ok) return error("DELETE_FAILED", `读取图片信息失败 (${head.status})`, 502);
    const sha = (await head.json()).sha;
    const del = await ghApi(env, `contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, { method: "DELETE", body: JSON.stringify({ message: `chore: delete ${path}`, sha, branch: "main" }) });
    if (!del.ok) return error("DELETE_FAILED", `GitHub 删除失败 (${del.status})`, 502);
    return json({ ok: true, path });
  } catch (cause) { return error("DELETE_FAILED", cause.message || "删除失败", 502); }
}
