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
export function publicOrigin(request, env) {
  const configured = runtimeEnv(env).PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0].trim();
  const host = forwardedHost || request.headers.get("host");
  if (host?.toLowerCase() === "images.6143443.xyz") return "https://images.6143443.xyz";
  return "https://images.6143443.xyz";
}
async function key(env) {
  const config = runtimeEnv(env);
  if (!config.SESSION_SECRET) throw new Error("SESSION_SECRET 未配置");
  return crypto.subtle.importKey("raw", encoder.encode(config.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sessionValue(login, env) { const payload = b64(encoder.encode(JSON.stringify({ login, exp: Date.now() + 86400000 }))); const signature = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload)))); return `${payload}.${signature}`; }
export async function readSession(request, env) { const value = getCookie(request, "image_session"); if (!value) return null; const [payload, signature] = value.split("."); if (!payload || !signature) return null; const valid = await crypto.subtle.verify("HMAC", await key(env), bytes(signature), encoder.encode(payload)); if (!valid) return null; try { const data = JSON.parse(decoder.decode(bytes(payload))); return data.exp > Date.now() ? data : null; } catch { return null; } }
export function sessionCookie(value) { return cookie("image_session", value, { maxAge: 86400, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearSessionCookie() { return cookie("image_session", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearOauthStateCookie() { return cookie("oauth_state", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }

function pemBytes(pem) { const raw = pem.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----|\s/g, ""); return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)); }
// crypto.subtle 只认 PKCS#8；GitHub App 下载的是 PKCS#1（BEGIN RSA PRIVATE KEY），需要包一层 PKCS#8 头
function toPkcs8(der) { const view = new DataView(der.buffer, der.byteOffset, der.byteLength); if (view.getUint16(0) === 0x3082 && der[4] === 0x02 && der[5] === 0x01 && der[6] === 0x30) return der; if (der.length > 65535 || der.length + 22 > 65535) throw new Error("私钥过长"); const seqLength = 22 + der.length; const header = [0x30, 0x82, (seqLength >> 8) & 255, seqLength & 255, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, 0x82, (der.length >> 8) & 255, der.length & 255]; const out = new Uint8Array(26 + der.length); out.set(header, 0); out.set(der, header.length); return out; }
function privateKeyBytes(config) {
  const encoded = config.GITHUB_APP_PRIVATE_KEY_B64 || [1, 2, 3].map((n) => config[`GITHUB_APP_PRIVATE_KEY_B64_${n}`] || "").join("");
  if (encoded) {
    const decoded = atob(encoded.replace(/\s/g, ""));
    const der = decoded.includes("BEGIN") ? pemBytes(decoded) : Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    return toPkcs8(der);
  }
  if (!config.GITHUB_APP_PRIVATE_KEY) throw new Error("GITHUB_APP_PRIVATE_KEY_B64(_1/_2/_3) 未配置");
  return toPkcs8(pemBytes(config.GITHUB_APP_PRIVATE_KEY));
}
async function appJwt(env) { const config = runtimeEnv(env); const header = b64(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))); const payload = b64(encoder.encode(JSON.stringify({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 540, iss: config.GITHUB_APP_ID }))); const key = await crypto.subtle.importKey("pkcs8", privateKeyBytes(config), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); const signature = b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)))); return `${header}.${payload}.${signature}`; }
export async function installationToken(env) { const config = runtimeEnv(env); const response = await fetch(`https://api.github.com/app/installations/${config.GITHUB_APP_INSTALLATION_ID}/access_tokens`, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await appJwt(env)}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!response.ok) throw new Error("GitHub App 安装令牌获取失败"); return (await response.json()).token; }

export async function githubUser(code, redirectUri, env) { const config = runtimeEnv(env); const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: config.GITHUB_APP_CLIENT_ID, client_secret: config.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }) }); if (!tokenResponse.ok) throw new Error("GitHub OAuth 换取令牌失败"); const token = (await tokenResponse.json()).access_token; if (!token) throw new Error("GitHub OAuth 未返回令牌"); const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!userResponse.ok) throw new Error("GitHub 用户信息获取失败"); return userResponse.json(); }
