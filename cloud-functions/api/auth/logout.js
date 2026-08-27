import { clearSessionCookie, revokeCurrentSession } from "../../_lib/auth.js";
import { json } from "../../_lib/http.js";
export async function onRequest({ request, env }) {
  try { await revokeCurrentSession(request, env); } catch { /* 吊销失败也照常登出：至少本机 cookie 已清 */ }
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
