const defaultBase = (env) => `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@main`;
export function imageBase(env, settings = {}) {
  const value = settings.accelerator_base_url;
  if (value) { try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password && !url.pathname.replace(/\/$/, "") && !url.search && !url.hash) return value.replace(/\/$/, ""); } catch {} }
  return defaultBase(env);
}
export function imageUrl(env, path, settings) { return `${imageBase(env, settings)}/${path.split("/").map(encodeURIComponent).join("/")}`; }
