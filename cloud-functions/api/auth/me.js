import { readSession } from "../../_lib/auth.js";
import { clearOauthStateCookie } from "../../_lib/auth.js";
import { error, json } from "../../_lib/http.js";
export async function onRequest({ request, env }) {
  try {
    const session = await readSession(request, env);
    const body = JSON.stringify(session ? { authenticated: true, login: session.login, avatar_url: session.avatar_url || null } : { authenticated: false });
    return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "Set-Cookie": clearOauthStateCookie() } });
  } catch {
    return error("AUTH_FAILED", "认证暂不可用，请稍后重试", 503);
  }
}
