import { ghApi } from "../_lib/github.js";
import { readSession, isAdminSession } from "../_lib/auth.js";
import { readHistoryCache, writeHistoryCache, loadState, readMemoryHistory, writeMemoryHistory } from "../_lib/state.js";
import { readIndex, writeIndex, itemsToRecords, recordsToItems, thumbPathOf } from "../_lib/history-index.js";
import { json, error } from "../_lib/http.js";
import { imageUrl } from "../_lib/image-url.js";
import { partitionOf } from "../_lib/partition.js";

const imagePath = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/.+\.(?:png|jpe?g|gif|webp|mp4)$/i;
const fileTypeOf = (path) => /\.mp4$/i.test(path) ? "video" : "image";
// KV 里缓存的数据最长复用 10 分钟；无 KV 时退回实例内存缓存
const KV_CACHE_TTL_MS = 600000;

// 全量 tree 扫描：只在索引缺失/损坏/被要求重建时兜底，仓库文件数大了以后可能被 GitHub 截断
async function scanTree(env) {
  const response = await ghApi(env, "git/trees/main?recursive=1");
  if (!response.ok) throw new Error(`GitHub tree 读取失败 (${response.status})`);
  const tree = await response.json();
  if (tree.truncated) throw new Error("GitHub tree 结果不完整");
  const blobs = (tree.tree || []).filter((entry) => entry.type === "blob");
  const thumbSet = new Set(blobs.filter((entry) => entry.path.startsWith(".thumbnails/")).map((entry) => entry.path));
  return blobs
    .filter((entry) => imagePath.test(entry.path))
    .map((entry) => ({
      path: entry.path,
      type: fileTypeOf(entry.path),
      ...(Number.isSafeInteger(entry.size) ? { bytes: entry.size } : {}),
      ...(thumbSet.has(thumbPathOf(entry.path)) ? { thumb: thumbPathOf(entry.path) } : {}),
    }))
    .reverse();
}

// 冷路径优先读仓库内索引（一次 contents 请求）；读不到才扫全量 tree 并顺手把索引建起来
async function loadItems(env, rebuild) {
  if (!rebuild) {
    try {
      const indexed = await readIndex(env);
      if (indexed) return recordsToItems(indexed.records);
    } catch (cause) { console.warn("[history] 索引读取失败，回退全量扫描:", cause.message); }
  }
  const items = await scanTree(env);
  await writeIndex(env, itemsToRecords(items), "chore: rebuild image index").catch((cause) => console.warn("[history] 索引重建写入失败:", cause.message));
  return items;
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
  const scope = (url.searchParams.get("scope") || "mine").slice(0, 16);
  try {
    const currentState = await loadState(config);
    const settings = currentState.settings || {};
    let items = readMemoryHistory();
    if (!items) {
      const cached = await readHistoryCache(config);
      const rebuild = url.searchParams.get("rebuild") === "1" && isAdminSession(session, env);
      if (cached && !rebuild && Date.now() - cached.savedAt < KV_CACHE_TTL_MS) { items = cached.items; writeMemoryHistory(items); }
      else { items = await loadItems(config, rebuild); await writeHistoryCache(config, items); writeMemoryHistory(items); }
    }
    // 每项按记录的 commit 引用生成地址：钉到 commit 时 CDN 给 immutable 长缓存，未知时退回 @main。
    // 缩略图可能比原图晚提交（存量补图），所以只在自己的 m 存在时才钉，否则退回 @main 避免 404
    const normalizeItems = (list) => list.map((item) => {
      const ref = item.commit || "main";
      return { ...item, partition: item.partition ?? partitionOf(item.path), type: item.type ?? fileTypeOf(item.path), url: imageUrl(config, item.path, settings, ref), ...(item.thumb ? { thumb: imageUrl(config, thumbPathOf(item.path), settings, item.thumbCommit || "main") } : {}) };
    });
    items = normalizeItems(items);
    // 视图范围与数据隔离：
    // 普通用户：始终只能看明确属于自己的图片
    // 管理员：
    //   - scope="mine"（默认）：只看自己上传的图片 + 历史未标记 owner 的旧图片（存量老图）
    //   - scope="all"：查看全库图片（包含其他用户上传的图片，用于内容审核与维护）
    const owners = currentState.owners || {};
    const isAdmin = isAdminSession(session, env);

    items = items.map((item) => ({ ...item, owner: owners[item.path] || "" }));
    if (!isAdmin || scope !== "all") {
      if (isAdmin) {
        items = items.filter((item) => !item.owner || item.owner === session.login);
      } else {
        items = items.filter((item) => item.owner && item.owner === session.login);
      }
    }
    const partitions = [...new Set(items.map((item) => item.partition || "").filter(Boolean))];
    if (partition === "default") items = items.filter((item) => !item.partition);
    else if (partition !== "all") items = items.filter((item) => item.partition === partition);
    const start = (page - 1) * perPage; const slice = items.slice(start, start + perPage);
    return json({ items: slice, partitions, total: items.length, page, per_page: perPage, has_next: start + perPage < items.length }, 200, { "Cache-Control": "no-store" });
  } catch { return error("HISTORY_FAILED", "历史记录暂时无法读取", 502); }
}
