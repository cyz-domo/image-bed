import { publicOrigin } from "../../_lib/auth.js";
import { error, cookie } from "../../_lib/http.js";
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
// 配置缺失时优先回跳站点并带 ?auth=error，让用户看到提示而不是裸 JSON；站点地址本身不可知才退回 JSON
const configFailure = (request, env, message) => {
  try {
    return new Response(null, { status: 302, headers: { Location: `${publicOrigin(request, env)}/?auth=error&reason=config`, "Cache-Control": "no-store" } });
  } catch {
    return error("CONFIGURATION_ERROR", message, 503);
  }
};

export async function onRequest({ request, env }) {
  const config = runtimeEnv(env);
  let callbackUrl;
  try {
    callbackUrl = `${publicOrigin(request, env)}/api/auth/callback`;
  } catch (cause) {
    return configFailure(request, env, cause.message);
  }
  if (!config.GITHUB_APP_CLIENT_ID) return configFailure(request, env, "GITHUB_APP_CLIENT_ID 未配置");
  const state = b64(crypto.getRandomValues(new Uint8Array(24)));
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", config.GITHUB_APP_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callbackUrl);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize,
      "Cache-Control": "no-store",
      "Set-Cookie": cookie("oauth_state", state, { maxAge: 600, path: "/", httpOnly: true, secure: true, sameSite: "Lax" })
    }
  });
}
