import { ghApi } from "../_lib/github.js";
import { readHistoryCache, writeHistoryCache } from "../_lib/state.js";
import { json, error } from "../_lib/http.js";

const imagePath = /^images\/\d{4}\/\d{2}\/.+\.(?:png|jpe?g|gif|webp)$/i;
const baseUrl = (path, env) => `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@main/${path}`;
// KV 里缓存的数据最长复用 10 分钟；无 KV 时退回实例内存缓存
const KV_CACHE_TTL_MS = 600000;
const memory = { expires: 0, items: [] };

async function fetchFromGitHub(env) {
  const response = await ghApi(env, "git/trees/main?recursive=1");
  if (!response.ok) throw new Error(`GitHub tree 读取失败 (${response.status})`);
  const tree = await response.json();
  return (tree.tree || []).filter((item) => item.type === "blob" && imagePath.test(item.path)).map((item) => ({ path: item.path, url: baseUrl(item.path, env) })).reverse();
}

export async function onRequest({ request, env }) {
  const config = env || {};
  const url = new URL(request.url); const page = Math.max(1, Number(url.searchParams.get("page") || 1)); const perPage = 30;
  try {
    let items = null;
    if (Date.now() > memory.expires) {
      const cached = await readHistoryCache(env);
      if (cached && Date.now() - cached.savedAt < KV_CACHE_TTL_MS) { items = cached.items; memory.items = items; memory.expires = Date.now() + 60000; }
      else { items = await fetchFromGitHub(config); await writeHistoryCache(env, items); memory.items = items; memory.expires = Date.now() + 60000; }
    } else items = memory.items;
    const start = (page - 1) * perPage; const slice = items.slice(start, start + perPage);
    return json({ items: slice, page, per_page: perPage, has_next: start + perPage < items.length }, 200, { "Cache-Control": "public, max-age=60, s-maxage=300" });
  } catch { return error("HISTORY_FAILED", "历史记录暂时无法读取", 502); }
}
