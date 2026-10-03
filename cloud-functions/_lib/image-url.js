const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
// ref 为 40 位 commit sha 时 jsDelivr 会给 immutable 长缓存；其余（含异常值）一律落回分支名
const refOf = (ref) => (/^[0-9a-f]{40}$/.test(String(ref || "").toLowerCase()) ? String(ref) : "main");
const defaultBase = (env, ref) => `https://cdn.jsdelivr.net/gh/${runtimeEnv(env).GITHUB_OWNER}/${runtimeEnv(env).GITHUB_REPO}@${refOf(ref)}`;
export function imageBase(env, settings = {}, ref = "main") {
  const config = runtimeEnv(env);
  const value = settings?.accelerator_base_url;
  if (value) { try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password && !url.pathname.replace(/\/$/, "") && !url.search && !url.hash) return `${value.replace(/\/$/, "")}/gh/${config.GITHUB_OWNER}/${config.GITHUB_REPO}@${refOf(ref)}`; } catch {} }
  return defaultBase(env, ref);
}
export function imageUrl(env, path, settings, ref = "main") { return `${imageBase(env, settings, ref)}/${path.split("/").map(encodeURIComponent).join("/")}`; }
