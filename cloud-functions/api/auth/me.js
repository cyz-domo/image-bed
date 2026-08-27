import { readSession, clearOauthStateCookie } from "../../_lib/auth.js";
import { error, json } from "../../_lib/http.js";
export async function onRequest({ request, env }) {
  try {
    const session = await readSession(request, env);
    const body = JSON.stringify(session ? { authenticated: true, login: session.login } : { authenticated: false });
    return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "Set-Cookie": clearOauthStateCookie() } });
  } catch (cause) {
    return error("AUTH_RUNTIME_CONFIG", cause.message || "认证配置错误", 500);
  }
}
