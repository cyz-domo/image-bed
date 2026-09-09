const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
const defaultBase = (env) => {
  const config = runtimeEnv(env);
  return `https://cdn.jsdelivr.net/gh/${config.GITHUB_OWNER}/${config.GITHUB_REPO}@main`;
};
export function imageBase(env, settings = {}) {
  const config = runtimeEnv(env);
  const value = settings.accelerator_base_url;
  if (value) { try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password && !url.pathname.replace(/\/$/, "") && !url.search && !url.hash) return `${value.replace(/\/$/, "")}/gh/${config.GITHUB_OWNER}/${config.GITHUB_REPO}@main`; } catch {} }
  return defaultBase(env);
}
export function imageUrl(env, path, settings) { return `${imageBase(env, settings)}/${path.split("/").map(encodeURIComponent).join("/")}`; }

