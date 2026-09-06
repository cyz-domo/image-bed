import { cookie, getCookie } from "./http.js";
import { loadState, updateState, revokeSession } from "./state.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes) => { let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); };
const bytes = (text) => {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
export function publicOrigin(request, env) {
  const configured = runtimeEnv(env).PUBLIC_BASE_URL;
  if (!configured) throw Object.assign(new Error("PUBLIC_BASE_URL 未配置"), { code: "PUBLIC_BASE_URL_MISSING" });
  let parsed;
  try { parsed = new URL(configured); } catch { throw Object.assign(new Error("PUBLIC_BASE_URL 必须是有效 URL"), { code: "PUBLIC_BASE_URL_INVALID" }); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw Object.assign(new Error("PUBLIC_BASE_URL 必须是 HTTPS origin"), { code: "PUBLIC_BASE_URL_INVALID" });
  return parsed.origin;
}
export function authUnavailable(cause) { return cause?.code === "AUTH_STORE_UNAVAILABLE"; }
async function key(env) {
  const config = runtimeEnv(env);
  if (!config.SESSION_SECRET) throw new Error("SESSION_SECRET 未配置");
  return crypto.subtle.importKey("raw", encoder.encode(config.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sessionValue(login, env, avatarUrl = "", email = "") { const sessionId = b64(crypto.getRandomValues(new Uint8Array(12))); const safeAvatar = typeof avatarUrl === "string" && /^https:\/\//.test(avatarUrl) ? avatarUrl : ""; const safeEmail = typeof email === "string" ? email.slice(0, 254) : ""; const payload = b64(encoder.encode(JSON.stringify({ login, avatar_url: safeAvatar, email: safeEmail, sid: sessionId, exp: Date.now() + 86400000 }))); const signature = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload)))); return `${payload}.${signature}`; }

// 允许名单：环境变量 ALLOWED_GITHUB_LOGIN（管理员）+ 设置中的 allowed_users（用户名或公开邮箱）
export function allowedLogins(state, env) { const config = runtimeEnv(env); return new Set([config.ALLOWED_GITHUB_LOGIN, ...((state?.settings?.allowed_users) || [])].filter(Boolean).map((value) => String(value).trim().toLowerCase())); }
export function userMatchesAllowlist(user, env, state) { const allowed = allowedLogins(state, env); return [user?.login, user?.email].some((value) => typeof value === "string" && allowed.has(value.trim().toLowerCase())); }
export function isAdminSession(session, env) { const admin = runtimeEnv(env).ALLOWED_GITHUB_LOGIN; return !!session?.login && !!admin && session.login.toLowerCase() === String(admin).trim().toLowerCase(); }
export async function readSession(request, env) {
  const value = getCookie(request, "image_session"); if (!value) return null; const [payload, signature] = value.split("."); if (!payload || !signature) return null;
  const valid = await crypto.subtle.verify("HMAC", await key(env), bytes(signature), encoder.encode(payload)); if (!valid) return null;
  try {
    const data = JSON.parse(decoder.decode(bytes(payload))); if (data.exp <= Date.now()) return null;
    if (data.sid) {
      try { if ((await loadState(env)).revoked.includes(data.sid)) return null; }
      catch (cause) { throw Object.assign(new Error("会话吊销状态暂不可用"), { code: "AUTH_STORE_UNAVAILABLE", cause }); }
    }
    return data;
  } catch { return null; }
}
export function sessionCookie(value) { return cookie("image_session", value, { maxAge: 86400, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearSessionCookie() { return cookie("image_session", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearOauthStateCookie() { return cookie("oauth_state", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }

export async function revokeCurrentSession(request, env) { const session = await readSession(request, env); if (session?.sid) await updateState((state) => revokeSession(state, session.sid), env); }

export async function githubUser(code, redirectUri, env) { const config = runtimeEnv(env); const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: config.GITHUB_APP_CLIENT_ID, client_secret: config.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }) }); if (!tokenResponse.ok) throw new Error("GitHub OAuth 换取令牌失败"); const token = (await tokenResponse.json()).access_token; if (!token) throw new Error("GitHub OAuth 未返回令牌"); const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!userResponse.ok) throw new Error("GitHub 用户信息获取失败"); return userResponse.json(); }
