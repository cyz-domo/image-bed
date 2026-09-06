import { ghApi } from "../_lib/github.js";
import { readSession, isAdminSession } from "../_lib/auth.js";
import { error, json } from "../_lib/http.js";

export async function onRequest({ request, env }) {
  let session = null;
  try {
    session = await readSession(request, env);
  } catch {}
  if (!session || !isAdminSession(session, env)) return error("FORBIDDEN", "仅管理员可访问", 403);

  const resp = await ghApi(env, `git/trees/main?recursive=1`);
  if (!resp.ok) return error("FETCH_FAILED", "获取仓库树失败", resp.status);

  const tree = await resp.json();
  const entries = tree.tree || [];

  let totalImages = 0;
  let totalSize = 0;
  const monthlyCounts = {};
  const monthlySizes = {};

  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (!entry.path.startsWith("images/")) continue;
    const size = entry.size || 0;
    totalImages += 1;
    totalSize += size;

    const parts = entry.path.split("/");
    if (parts.length >= 4) {
      const year = parts[parts.length - 3];
      const month = parts[parts.length - 2];
      const key = `${year}-${month}`;
      monthlyCounts[key] = (monthlyCounts[key] || 0) + 1;
      monthlySizes[key] = (monthlySizes[key] || 0) + size;
    }
  }

  return json({ totalImages, totalSize, monthlyCounts, monthlySizes });
}
