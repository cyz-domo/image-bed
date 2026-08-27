const encoder = new TextEncoder();
const b64 = (bytes) => { let result = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(result); };

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
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
async function appJwt(config) { const header = b64(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))); const payload = b64(encoder.encode(JSON.stringify({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 540, iss: config.GITHUB_APP_ID }))); const key = await crypto.subtle.importKey("pkcs8", privateKeyBytes(config), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); const signature = b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)))); return `${header}.${payload}.${signature}`; }

// 安装令牌缓存：避免每个请求都签 JWT + 换令牌（令牌本身有效期 1 小时）
const cachedToken = { token: null, expiresAt: 0 };
export async function installationToken(env) {
  if (cachedToken.token && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const config = runtimeEnv(env);
  const response = await fetch(`https://api.github.com/app/installations/${config.GITHUB_APP_INSTALLATION_ID}/access_tokens`, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await appJwt(config)}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error("GitHub App 安装令牌获取失败");
  const token = (await response.json()).token;
  cachedToken.token = token; cachedToken.expiresAt = Date.now() + 45 * 60 * 1000;
  return token;
}

export async function ghApi(env, repoPath, init = {}) {
  const config = runtimeEnv(env);
  const response = await fetch(`https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/${repoPath}`, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await installationToken(env)}`, "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) } });
  return response;
}
