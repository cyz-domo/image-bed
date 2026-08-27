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
export async function sessionValue(login, env) { const sessionId = b64(crypto.getRandomValues(new Uint8Array(12))); const payload = b64(encoder.encode(JSON.stringify({ login, sid: sessionId, exp: Date.now() + 86400000 }))); const signature = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload)))); return `${payload}.${signature}`; }
export async function readSession(request, env) {
  const value = getCookie(request, "image_session"); if (!value) return null; const [payload, signature] = value.split("."); if (!payload || !signature) return null;
  const valid = await crypto.subtle.verify("HMAC", await key(env), bytes(signature), encoder.encode(payload)); if (!valid) return null;
  try {
    const data = JSON.parse(decoder.decode(bytes(payload))); if (data.exp <= Date.now()) return null;
    if (data.sid) { if ((await loadState()).revoked.includes(data.sid)) return null; }
    return data;
  } catch { return null; }
}
export function sessionCookie(value) { return cookie("image_session", value, { maxAge: 86400, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearSessionCookie() { return cookie("image_session", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }
export function clearOauthStateCookie() { return cookie("oauth_state", "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }); }

export async function revokeCurrentSession(request, env) { const session = await readSession(request, env); if (session?.sid) await updateState((state) => revokeSession(state, session.sid)); }
