import { json, error } from "../_lib/http.js";

let cache = { expires: 0, items: [] };
const imagePath = /^images\/\d{4}\/\d{2}\/.+\.(?:png|jpe?g|gif|webp)$/i;
const baseUrl = (path, env) => `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@main/${path}`;

export async function onRequest({ request, env }) {
  const config = env || {};
  const url = new URL(request.url); const page = Math.max(1, Number(url.searchParams.get("page") || 1)); const perPage = 30;
  try {
    if (Date.now() > cache.expires) {
      const response = await fetch(`https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/git/trees/main?recursive=1`, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
      if (!response.ok) return error("HISTORY_UPSTREAM_FAILED", "历史记录暂时无法读取", 502);
      const tree = await response.json();
      cache.items = (tree.tree || []).filter((item) => item.type === "blob" && imagePath.test(item.path)).map((item) => ({ path: item.path, url: baseUrl(item.path, config) })).reverse();
      cache.expires = Date.now() + Number(config.HISTORY_CACHE_TTL || 300) * 1000;
    }
    const start = (page - 1) * perPage; const items = cache.items.slice(start, start + perPage);
    return json({ items, page, per_page: perPage, has_next: start + perPage < cache.items.length }, 200, { "Cache-Control": "public, max-age=60, s-maxage=300" });
  } catch { return error("HISTORY_FAILED", "历史记录暂时无法读取", 502); }
}
