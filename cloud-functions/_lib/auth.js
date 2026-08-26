import { cookie, getCookie } from "./http.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const bytes = (text) => {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
async function key(env) {
  const config = runtimeEnv(env);
  if (!config.SESSION_SECRET) throw new Error("SESSION_SECRET 未配置");
  return crypto.subtle.importKey("raw", encoder.encode(config.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sessionValue(login, env) { const payload = b64(encoder.encode(JSON.stringify({ login, exp: Date.now() + 86400000 }))); const signature = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload)))); return `${payload}.${signature}`; }
export async function readSession(request, env) { const value = getCookie(request, "image_session"); if (!value) return null; const [payload, signature] = value.split("."); if (!payload || !signature) return null; const valid = await crypto.subtle.verify("HMAC", await key(env), bytes(signature), encoder.encode(payload)); if (!valid) return null; try { const data = JSON.parse(decoder.decode(bytes(payload))); return data.exp > Date.now() ? data : null; } catch { return null; } }
export function sessionCookie(value) { return cookie("image_session", value, { maxAge: 86400, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearSessionCookie() { return cookie("image_session", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }

function pemBytes(pem) { const raw = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ""); return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)); }
function privateKeyBytes(config) {
  const encoded = config.GITHUB_APP_PRIVATE_KEY_B64 || `${config.GITHUB_APP_PRIVATE_KEY_B64_1 || ""}${config.GITHUB_APP_PRIVATE_KEY_B64_2 || ""}`;
  if (encoded) return Uint8Array.from(atob(encoded.replace(/\s/g, "")), (char) => char.charCodeAt(0));
  if (!config.GITHUB_APP_PRIVATE_KEY) throw new Error("GITHUB_APP_PRIVATE_KEY_B64(_1/_2) 未配置");
  return pemBytes(config.GITHUB_APP_PRIVATE_KEY);
}
async function appJwt(env) { const config = runtimeEnv(env); const header = b64(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))); const payload = b64(encoder.encode(JSON.stringify({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 540, iss: config.GITHUB_APP_ID }))); const key = await crypto.subtle.importKey("pkcs8", privateKeyBytes(config), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); const signature = b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)))); return `${header}.${payload}.${signature}`; }
export async function installationToken(env) { const config = runtimeEnv(env); const response = await fetch(`https://api.github.com/app/installations/${config.GITHUB_APP_INSTALLATION_ID}/access_tokens`, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await appJwt(env)}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!response.ok) throw new Error("GitHub App 安装令牌获取失败"); return (await response.json()).token; }

export async function githubUser(code, redirectUri, env) { const config = runtimeEnv(env); const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: config.GITHUB_APP_CLIENT_ID, client_secret: config.GITHUB_APP_CLIENT_SECRET, code, redirect_uri }) }); if (!tokenResponse.ok) throw new Error("GitHub OAuth 换取令牌失败"); const token = (await tokenResponse.json()).access_token; if (!token) throw new Error("GitHub OAuth 未返回令牌"); const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!userResponse.ok) throw new Error("GitHub 用户信息获取失败"); return userResponse.json(); }
