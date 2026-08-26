import { readSession } from "../../_lib/auth.js";
import { error, json } from "../../_lib/http.js";
export async function onRequest({ request, env }) {
  try {
    const session = await readSession(request, env);
    return json(session ? { authenticated: true, login: session.login } : { authenticated: false });
  } catch (cause) {
    return error("AUTH_RUNTIME_CONFIG", cause.message || "认证配置错误", 500);
  }
}
