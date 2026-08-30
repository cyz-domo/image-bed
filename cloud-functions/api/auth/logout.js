import { clearSessionCookie, revokeCurrentSession } from "../../_lib/auth.js";
import { error, json } from "../../_lib/http.js";
export async function onRequest({ request, env }) {
  try { await revokeCurrentSession(request, env); return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() }); }
  catch (cause) { console.warn("会话吊销失败", cause); return error("LOGOUT_FAILED", "服务端会话吊销失败，请稍后重试", 503, { "Set-Cookie": clearSessionCookie() }); }
}
