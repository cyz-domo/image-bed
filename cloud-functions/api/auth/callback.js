import { githubUser, publicOrigin, sessionCookie, sessionValue, userMatchesAllowlist } from "../../_lib/auth.js";
import { loadState } from "../../_lib/state.js";
import { error, getCookie } from "../../_lib/http.js";

// 回跳一律带 ?auth=，让前端能提示登录结果；reason 是固定白名单码，页面按码给文案
const resultUrl = (origin, query, reason) => {
  const url = new URL("/", origin);
  url.searchParams.set("auth", query);
  if (reason) url.searchParams.set("reason", reason);
  return url.href;
};
const redirect = (location, headers) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...(headers || {}) } });

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthState = url.searchParams.get("state");
  let origin;
  try { origin = publicOrigin(request, env); } catch { return error("CONFIGURATION_ERROR", "站点地址未配置，无法完成登录回跳", 503); }
  if (!code || !oauthState || oauthState !== getCookie(request, "oauth_state")) return redirect(resultUrl(origin, "error", "state"));
  try {
    const user = await githubUser(code, `${origin}/api/auth/callback`, env);
    const stateData = await loadState(env);
    if (!userMatchesAllowlist(user, env, stateData)) return redirect(resultUrl(origin, "error", "allowed"));
    return redirect(resultUrl(origin, "success"), { "Set-Cookie": sessionCookie(await sessionValue(user.login, env, user.avatar_url, user.email)) });
  } catch {
    return redirect(resultUrl(origin, "error", "oauth"));
  }
}
