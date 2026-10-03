import { ghApi } from "./github.js";

// 图库索引：随上传/删除一起提交进仓库的紧凑清单，让 /api/history 的冷路径
// 只需读这一个小文件，而不必递归拉整棵 Git tree（成本随仓库总文件数线性增长且会被截断）。
// 记录字段：p=图片路径，t=存在同名缩略图，s=原图字节数，
// c=包含该图片的 commit sha，m=包含其缩略图的 commit sha（两者拼成 immutable 的 CDN 地址）
const INDEX_PATH = ".state/index.json";
const INDEX_LIMIT = 900_000; // contents API 单文件上限 1 MB，留出编码与并发余量
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_PATH = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/.+$/;
const fileTypeOf = (path) => (/\.mp4$/i.test(path) ? "video" : "image");
const thumbPathOf = (path) => `.thumbnails/${path.slice("images/".length)}`;
const commitOf = (value) => (typeof value === "string" && COMMIT_SHA.test(value) ? value.toLowerCase() : undefined);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fromBase64 = (text) => decoder.decode(Uint8Array.from(atob(text.replace(/\s/g, "")), (char) => char.charCodeAt(0)));
const toBase64 = (text) => { const bytes = encoder.encode(text); let binary = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk)); return btoa(binary); };

// 只有路径不合法的记录会被丢弃；其余脏字段（非法 sha/字节数）在清洗时忽略，避免一个坏字段让图片从列表里消失
export function isValidIndexRecord(record) {
  return !!record && typeof record === "object" && typeof record.p === "string" && IMAGE_PATH.test(record.p);
}

// 清洗 + 去重（后写覆盖前写）+ 按路径倒序，保证索引顺序即"最新优先"的近似顺序
export function normalizeRecords(records) {
  const byPath = new Map();
  for (const record of records || []) {
    if (!isValidIndexRecord(record)) continue;
    const clean = { p: record.p };
    if (record.t === 1 || record.t === true) clean.t = 1;
    if (Number.isSafeInteger(record.s) && record.s >= 0) clean.s = record.s;
    const commit = commitOf(record.c); const thumbCommit = commitOf(record.m);
    if (commit) clean.c = commit;
    if (thumbCommit) clean.m = thumbCommit;
    byPath.set(record.p, clean);
  }
  return [...byPath.values()].sort((a, b) => (a.p < b.p ? 1 : a.p > b.p ? -1 : 0));
}

export function serializeIndex(records) {
  const clean = normalizeRecords(records);
  const text = JSON.stringify({ v: 1, count: clean.length, items: clean });
  if (text.length > INDEX_LIMIT) throw Object.assign(new Error(`图库索引超过 ${INDEX_LIMIT} 字节上限`), { code: "INDEX_TOO_LARGE" });
  return text;
}

export function parseIndex(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) return null;
    return normalizeRecords(parsed.items);
  } catch { return null; }
}

// items: [{ path, thumbPath | thumb?, bytes?, commit?, thumbCommit? }]
// 同批上传的图片与缩略图落在同一个 commit，未显式给 thumbCommit 时沿用 commit
export function upsertRecords(records, items) {
  const merged = normalizeRecords(records);
  const byPath = new Map(merged.map((record) => [record.p, record]));
  for (const item of items || []) {
    if (!item?.path || !IMAGE_PATH.test(item.path)) continue;
    const record = byPath.get(item.path) || { p: item.path };
    const hasThumb = Boolean(item.thumbPath || item.thumb);
    const commit = commitOf(item.commit);
    if (hasThumb) record.t = 1;
    if (Number.isSafeInteger(item.bytes) && item.bytes >= 0) record.s = item.bytes;
    if (commit) record.c = commit;
    const thumbCommit = commitOf(item.thumbCommit) || (hasThumb ? commit : undefined);
    if (record.t === 1 && thumbCommit) record.m = thumbCommit;
    byPath.set(item.path, record);
  }
  return normalizeRecords([...byPath.values()]);
}

export function dropRecords(records, paths) {
  const remove = new Set(paths || []);
  return normalizeRecords((records || []).filter((record) => !remove.has(record.p)));
}

export function recordsToItems(records) {
  return (records || []).filter(isValidIndexRecord).map((record) => ({
    path: record.p,
    type: fileTypeOf(record.p),
    ...(record.t === 1 ? { thumb: thumbPathOf(record.p) } : {}),
    ...(Number.isSafeInteger(record.s) ? { bytes: record.s } : {}),
    ...(record.c ? { commit: record.c } : {}),
    ...(record.m ? { thumbCommit: record.m } : {}),
  }));
}

export function itemsToRecords(items) {
  return upsertRecords([], (items || []).map((item) => ({
    path: item.path,
    thumbPath: item.thumb ? thumbPathOf(item.path) : "",
    bytes: Number.isSafeInteger(item.bytes) ? item.bytes : undefined,
    commit: item.commit,
    thumbCommit: item.thumbCommit,
  })));
}

// 读索引；返回 { records, sha }，不存在或损坏返回 null
export async function readIndex(env) {
  const response = await ghApi(env, `contents/${INDEX_PATH}?ref=main`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`图库索引读取失败 (${response.status})`);
  const body = await response.json();
  if (typeof body.content !== "string") return null;
  const records = parseIndex(fromBase64(body.content));
  return records ? { records, sha: body.sha } : null;
}

async function putIndex(env, records, sha, message) {
  return ghApi(env, `contents/${INDEX_PATH}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(serializeIndex(records)), branch: "main", ...(sha ? { sha } : {}) }),
  });
}

// 独立提交写入索引（上传/直传登记用：新 commit sha 只能在图片提交后得知）
// 并发写冲突（409）时重读索引合并后重试，避免任何一次上传的条目被永久丢掉
export async function writeIndex(env, records, message) {
  let current = normalizeRecords(records);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let sha = null;
    try { const existing = await readIndex(env); if (existing) { sha = existing.sha; current = upsertRecords(existing.records, recordsToItems(current)); } } catch {}
    const response = await putIndex(env, current, sha, message).catch(() => null);
    if (response && response.ok) return true;
    if (response && response.status !== 409) return false;
  }
  return false;
}

// 作为 tree 条目随其他改动同一次提交写入（删除、重建索引用）
export async function indexBlobEntry(env, records) {
  const content = serializeIndex(records);
  const response = await ghApi(env, "git/blobs", { method: "POST", body: JSON.stringify({ content: toBase64(content), encoding: "base64" }) });
  if (!response.ok) throw new Error(`创建索引 Blob 失败 (${response.status})`);
  return { path: INDEX_PATH, mode: "100644", type: "blob", sha: (await response.json()).sha };
}

export { INDEX_PATH, thumbPathOf };
