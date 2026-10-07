const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
// ref 为 40 位 commit sha 时源站可给 immutable 长缓存；其余（含异常值）一律落回分支名
const refOf = (ref) => (/^[0-9a-f]{40}$/.test(String(ref || "").toLowerCase()) ? String(ref) : "main");
const defaultBase = (env, ref) => `https://cdn.jsdelivr.net/gh/${runtimeEnv(env).GITHUB_OWNER}/${runtimeEnv(env).GITHUB_REPO}@${refOf(ref)}`;

/* 加速域名是"回源 GitHub raw 的反向代理"，所以路径取 raw 的原生形态 /<owner>/<repo>/<ref>/<path>，
   不是 jsDelivr 的 /gh/<owner>/<repo>@<ref>/——raw 不认后者，换回源后混用会全部 404。
   弃用 jsDelivr 的原因：它对 /gh/ 有 50 MB 仓库上限，超限后各节点随机回
   "Package size exceeded the configured limit of 50 MB"（HTTP 403），表现为缩略图随机裂。 */
const acceleratorOrigin = (settings) => {
  const value = settings?.accelerator_base_url;
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.pathname.replace(/\/$/, "") && !url.search && !url.hash) return value.replace(/\/$/, "");
  } catch { /* 配置不合法时落回默认源 */ }
  return "";
};

export function imageBase(env, settings = {}, ref = "main") {
  const config = runtimeEnv(env);
  const origin = acceleratorOrigin(settings);
  if (origin) return `${origin}/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/${refOf(ref)}`;
  return defaultBase(env, ref);
}

export function imageUrl(env, path, settings, ref = "main") { return `${imageBase(env, settings, ref)}/${path.split("/").map(encodeURIComponent).join("/")}`; }

// 加速器还回源 jsDelivr 时生成、并留在状态里的旧形态链接（例如站点背景图），读时改写成新形态；
// 改写结果随下一次状态写入落回仓库，不需要手工迁移
export function normalizeCdnUrl(value, env, settings) {
  const url = String(value || "");
  const origin = acceleratorOrigin(settings);
  const config = runtimeEnv(env);
  const legacy = `${origin}/gh/${config.GITHUB_OWNER}/${config.GITHUB_REPO}@`;
  if (!origin || !url.startsWith(legacy)) return url;
  const slash = url.indexOf("/", legacy.length); // 跳过 @main 或 @<sha>
  if (slash < 0) return url;
  return `${origin}/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/main/${url.slice(slash + 1)}`;
}
