import { ghApi } from "../_lib/github.js";
import { readSession } from "../_lib/auth.js";
import { readHistoryCache, writeHistoryCache, loadState, readMemoryHistory, writeMemoryHistory } from "../_lib/state.js";
import { json, error } from "../_lib/http.js";
import { imageUrl } from "../_lib/image-url.js";
import { partitionOf } from "../_lib/partition.js";

const imagePath = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/.+\.(?:png|jpe?g|gif|webp|mp4)$/i;
const fileTypeOf = (path) => /\.mp4$/i.test(path) ? "video" : "image";
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
      return { path: item.path, partition: partitionOf(item.path), type: fileTypeOf(item.path), url: baseUrl(item.path, env, settings), ...(thumbSet.has(thumbPath) ? { thumb: baseUrl(thumbPath, env, settings) } : {}) };
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
  // 分区筛选：all=全部（默认），default=默认分区，其余为分区名精确匹配
  const partition = (url.searchParams.get("partition") || "all").slice(0, 64);
  try {
    const currentState = await loadState(config);
    const settings = currentState.settings || {};
    let items = readMemoryHistory();
    if (!items) {
      const cached = await readHistoryCache(config);
      if (cached && Date.now() - cached.savedAt < KV_CACHE_TTL_MS) { items = cached.items; writeMemoryHistory(items); }
      else { items = await fetchFromGitHub(config, settings); await writeHistoryCache(config, items); writeMemoryHistory(items); }
    }
    const normalizeItems = (list) => list.map((item) => ({ ...item, partition: item.partition ?? partitionOf(item.path), type: item.type ?? fileTypeOf(item.path), url: imageUrl(config, item.path, settings), ...(item.thumb ? { thumb: imageUrl(config, `.thumbnails/${item.path.slice("images/".length)}`, settings) } : {}) }));
    items = normalizeItems(items);
    // 数据隔离：图片按上传者归属，普通用户仅可见自己上传的，管理员可见全部
    const owners = currentState.owners || {};
    items = items.map((item) => ({ ...item, owner: owners[item.path] || "" }));
    items = items.filter((item) => !item.owner || item.owner === session.login);
    const partitions = [...new Set(items.map((item) => item.partition || "").filter(Boolean))];
    if (partition === "default") items = items.filter((item) => !item.partition);
    else if (partition !== "all") items = items.filter((item) => item.partition === partition);
    const start = (page - 1) * perPage; const slice = items.slice(start, start + perPage);
    return json({ items: slice, partitions, total: items.length, page, per_page: perPage, has_next: start + perPage < items.length }, 200, { "Cache-Control": "no-store" });
  } catch { return error("HISTORY_FAILED", "历史记录暂时无法读取", 502); }
}
