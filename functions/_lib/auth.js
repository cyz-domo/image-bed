import { cookie, getCookie } from "./http.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const bytes = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/") + "==="), (char) => char.charCodeAt(0));

async function key() { return crypto.subtle.importKey("raw", encoder.encode(process.env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
export async function sessionValue(login) { const payload = b64(encoder.encode(JSON.stringify({ login, exp: Date.now() + 86400000 }))); const signature = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(), encoder.encode(payload)))); return `${payload}.${signature}`; }
export async function readSession(request) { const value = getCookie(request, "image_session"); if (!value) return null; const [payload, signature] = value.split("."); if (!payload || !signature) return null; const valid = await crypto.subtle.verify("HMAC", await key(), bytes(signature), encoder.encode(payload)); if (!valid) return null; try { const data = JSON.parse(decoder.decode(bytes(payload))); return data.exp > Date.now() ? data : null; } catch { return null; } }
export function sessionCookie(value) { return cookie("image_session", value, { maxAge: 86400, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearSessionCookie() { return cookie("image_session", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }

function pemBytes(pem) { const raw = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ""); return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)); }
async function appJwt() { const header = b64(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))); const payload = b64(encoder.encode(JSON.stringify({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 540, iss: process.env.GITHUB_APP_ID }))); const key = await crypto.subtle.importKey("pkcs8", pemBytes(process.env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); const signature = b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)))); return `${header}.${payload}.${signature}`; }
export async function installationToken() { const response = await fetch(`https://api.github.com/app/installations/${process.env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await appJwt()}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!response.ok) throw new Error("GitHub App 安装令牌获取失败"); return (await response.json()).token; }

export async function githubUser(code, redirectUri) { const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: process.env.GITHUB_APP_CLIENT_ID, client_secret: process.env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }) }); if (!tokenResponse.ok) throw new Error("GitHub OAuth 换取令牌失败"); const token = (await tokenResponse.json()).access_token; if (!token) throw new Error("GitHub OAuth 未返回令牌"); const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!userResponse.ok) throw new Error("GitHub 用户信息获取失败"); return userResponse.json(); }

