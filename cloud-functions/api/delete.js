import { readSession, authUnavailable, isAdminSession } from "../_lib/auth.js";
import { ghApi } from "../_lib/github.js";
import { loadState, readHistoryCache, writeHistoryCache, updateState, invalidateHistoryCache } from "../_lib/state.js";
import { error, json } from "../_lib/http.js";

// 只允许删除 images/ 目录下的图片与视频文件（含分区前缀），防止路径穿越或误删其他内容
const imagePath = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/[\w一-鿿.-]+\.(?:png|jpe?g|gif|webp|mp4)$/i;
const encodePath = (path) => encodeURIComponent(path).replace(/%2F/g, "/");
const MAX_BATCH = 20;

// 批量删除：使用 GitHub Git Data API 构造单个 Commit 一次性删除所有文件（含缩略图）
// 每次批量请求仅需 4 次 GitHub API 调用，避免 API 配额消耗和 secondary rate limit
async function batchDelete(env, paths) {
  if (!paths.length) return { ok: true, deleted: [] };
  
  // 收集原图和对应存在的缩略图路径
  const treeEntries = [];
  for (const path of paths) {
    treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    treeEntries.push({ path: `.thumbnails/${path.slice("images/".length)}`, mode: "100644", type: "blob", sha: null });
  }

  try {
    // 1. 获取 main 分支最新 commit sha
    const refRes = await ghApi(env, "git/ref/heads/main");
    if (!refRes.ok) return { ok: false, message: `获取分支引用失败 (${refRes.status})` };
    const parentCommitSha = (await refRes.json()).object.sha;

    // 2. 获取基准 commit 对象，拿到 base_tree sha
    const commitRes = await ghApi(env, `git/commits/${parentCommitSha}`);
    if (!commitRes.ok) return { ok: false, message: `获取 Commit 失败 (${commitRes.status})` };
    const baseTreeSha = (await commitRes.json()).tree.sha;

    // 3. 创建包含删除条目的新 tree（sha: null 表示删除）
    const treeRes = await ghApi(env, "git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
    });
    if (!treeRes.ok) return { ok: false, message: `创建 Tree 失败 (${treeRes.status})` };
    const newTreeSha = (await treeRes.json()).sha;

    // 4. 创建新 Commit
    const message = paths.length === 1 ? `chore: delete ${paths[0]}` : `chore: delete ${paths.length} images`;
    const newCommitRes = await ghApi(env, "git/commits", {
      method: "POST",
      body: JSON.stringify({ message, tree: newTreeSha, parents: [parentCommitSha] })
    });
    if (!newCommitRes.ok) return { ok: false, message: `创建 Commit 失败 (${newCommitRes.status})` };
    const newCommitSha = (await newCommitRes.json()).sha;

    // 5. 更新 main 分支 ref
    const updateRefRes = await ghApi(env, "git/refs/heads/main", {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommitSha, force: false })
    });
    if (!updateRefRes.ok) return { ok: false, message: `更新分支引用失败 (${updateRefRes.status})` };

    return { ok: true, deleted: paths };
  } catch (cause) {
    return { ok: false, message: cause.message || "批量删除失败" };
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  let session; try { session = await readSession(request, env); } catch (cause) { if (authUnavailable(cause)) return error("AUTH_STORE_UNAVAILABLE", "会话服务暂不可用，请稍后重试", 503); throw cause; }
  if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    const body = await request.json().catch(() => ({}));
    // 兼容单个 path 与批量 paths
    const paths = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
    if (!paths.length || paths.length > MAX_BATCH) return error("PATH_INVALID", `一次最多删除 ${MAX_BATCH} 张`, 400);
    for (const path of paths) if (typeof path !== "string" || !imagePath.test(path)) return error("PATH_INVALID", `图片路径不合法: ${path}`, 400);

    // 数据隔离：普通用户只能删除自己上传的文件，管理员可删除全部（未记录归属的历史文件仅管理员可删）
    const owners = ((await loadState(env)).owners) || {};
    const isAdmin = isAdminSession(session, env);
    const results = [];
    const deletable = [];
    for (const path of paths) {
      const owner = owners[path] || "";
      if (!isAdmin && (!owner || owner !== session.login)) { results.push({ path, ok: false, message: "没有权限删除该文件" }); continue; }
      deletable.push(path);
    }
    // 使用 Git Data API 一次性批量删除
    let batchRes = { ok: true, deleted: [] };
    if (deletable.length > 0) {
      batchRes = await batchDelete(env, deletable);
    }

    const okPaths = batchRes.ok ? deletable : [];
    if (!batchRes.ok) {
      for (const path of deletable) {
        results.push({ path, ok: false, message: batchRes.message || "批量删除失败" });
      }
    } else {
      for (const path of deletable) {
        results.push({ path, ok: true });
      }
    }

    if (okPaths.length) {
      try { const cached = await readHistoryCache(env); if (cached) await writeHistoryCache(env, cached.items.filter((item) => !okPaths.includes(item.path))); } catch {}
      invalidateHistoryCache();
      try { await updateState((s) => { for (const path of okPaths) { delete s.links?.[path]; if (s.owners) delete s.owners[path]; } }, env); } catch {}
    }
    const failed = results.filter((r) => !r.ok);
    return json({ ok: failed.length === 0, deleted: okPaths, failed, failed_count: failed.length });
  } catch (cause) { return error("DELETE_FAILED", cause.message || "删除失败", 502); }
}
