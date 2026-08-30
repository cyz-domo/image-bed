import { ghApi } from "../_lib/github.js";
import { readSession } from "../_lib/auth.js";
import { readHistoryCache, writeHistoryCache, loadState, readMemoryHistory, writeMemoryHistory } from "../_lib/state.js";
import { json, error } from "../_lib/http.js";
import { imageUrl } from "../_lib/image-url.js";

const imagePath = /^images\/\d{4}\/\d{2}\/.+\.(?:png|jpe?g|gif|webp)$/i;
const baseUrl = (path, env, settings) => imageUrl(env, path, settings);
// KV 里缓存的数据最长复用 10 分钟；无 KV 时退回实例内存缓存
const KV_CACHE_TTL_MS = 600000;

async function fetchFromGitHub(env, settings) {
  const response = await ghApi(env, "git/trees/main?recursive=1");
  if (!response.ok) throw new Error(`GitHub tree 读取失败 (${response.status})`);
  const tree = await response.json();
  if (tree.truncated) throw new Error("GitHub tree 结果不完整");
  // thumb: 同名缩略图存于 .thumbnails/；存量老图没有则降级用原图
  const thumbSet = new Set((tree.tree || []).filter((item) => item.type === "blob" && item.path.startsWith(".thumbnails/")).map((item) => item.path));
  return (tree.tree || [])
    .filter((item) => item.type === "blob" && imagePath.test(item.path))
    .map((item) => {
      const thumbPath = `.thumbnails/${item.path.slice("images/".length)}`;
      return { path: item.path, url: baseUrl(item.path, env, settings), ...(thumbSet.has(thumbPath) ? { thumb: baseUrl(thumbPath, env, settings) } : {}) };
    })
    .reverse();
}


export async function onRequest({ request, env }) {
  const session = await readSession(request, env); if (!session) return error("UNAUTHENTICATED", "登录后可查看图片库", 401);
  const config = env || {};
  const url = new URL(request.url); const rawPage = Number(url.searchParams.get("page") || 1); const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= 100000 ? rawPage : 1;
  // 每页数量：4 的倍数，4-120（与桌面端 4 列瀑布流对齐），其他值落回默认 12
  const rawPerPage = Math.round(Number(url.searchParams.get("per_page")) / 4) * 4;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage >= 4 && rawPerPage <= 120 ? rawPerPage : 12;
  try {
    const currentState = await loadState(config);
    const settings = currentState.settings || {};
    let items = readMemoryHistory();
    if (!items) {
      const cached = await readHistoryCache(config);
      if (cached && Date.now() - cached.savedAt < KV_CACHE_TTL_MS) { items = cached.items; writeMemoryHistory(items); }
      else { items = await fetchFromGitHub(config, settings); await writeHistoryCache(config, items); writeMemoryHistory(items); }
    }
    const normalizeItems = (list) => list.map((item) => ({ ...item, url: imageUrl(config, item.path, settings), ...(item.thumb ? { thumb: imageUrl(config, `.thumbnails/${item.path.slice("images/".length)}`, settings) } : {}) }));
    items = normalizeItems(items);
    const start = (page - 1) * perPage; const slice = items.slice(start, start + perPage);
    return json({ items: slice, page, per_page: perPage, has_next: start + perPage < items.length }, 200, { "Cache-Control": "no-store" });
  } catch { return error("HISTORY_FAILED", "历史记录暂时无法读取", 502); }
}
