// 大文件直传凭证：EdgeOne 函数请求体上限 6MB，视频等大文件由浏览器持
// GitHub 安装令牌（约 1 小时有效，仅签发给已登录管理员）直接 PUT 到 GitHub API
import { readSession, authUnavailable } from "../../_lib/auth.js";
import { installationToken } from "../../_lib/github.js";
import { loadState, updateState, reserveDailyQuota } from "../../_lib/state.js";
import { error, json } from "../../_lib/http.js";

const defaultDailyLimit = 100;

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return error("METHOD_NOT_ALLOWED", "只支持 POST", 405);
  let session; try { session = await readSession(request, env); } catch (cause) { if (authUnavailable(cause)) return error("AUTH_STORE_UNAVAILABLE", "会话服务暂不可用，请稍后重试", 503); throw cause; }
  if (!session) return error("UNAUTHENTICATED", "请先使用 GitHub 登录", 401);
  try {
    let state = await loadState(env).catch(() => null);
    if (!state) { await updateState(() => {}, env); state = await loadState(env); }
    const limit = Number(state.settings?.daily_upload_limit || env.DAILY_UPLOAD_LIMIT || defaultDailyLimit);
    // 配额在签发凭证时预占；直传中断最多占用一个当日名额
    const reservation = await reserveDailyQuota(env, limit).catch((cause) => { if (cause?.code === "QUOTA_STORE_UNAVAILABLE") return null; throw cause; });
    if (!reservation) return error("QUOTA_STORE_UNAVAILABLE", "每日配额服务暂不可用，请稍后重试", 503);
    if (!reservation.allowed) return error("DAILY_LIMIT_REACHED", `今日上传已达上限（${limit} 张）`, 429);
    if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return error("REPO_NOT_CONFIGURED", "未配置目标仓库（GITHUB_OWNER / GITHUB_REPO）", 500);
    const token = await installationToken(env);
    return json({ token, owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, daily_remaining: reservation.remaining });
  } catch (cause) { return error("TOKEN_FAILED", cause?.message || "上传凭证获取失败", 502); }
}
