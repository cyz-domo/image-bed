# EdgeOne + GitHub OAuth 图床设计

## 目标

为 `cyz-domo/image-bed` 增加一个部署在 EdgeOne Pages 的网页上传入口。任何人可以查看公开历史链接，但只有 GitHub 账号 `cyz-domo` 可以上传；图片写入公开 GitHub 仓库，并返回 jsDelivr CDN 地址和 Markdown 格式。

## 方案

采用单个 EdgeOne 项目承载静态前端和 Edge Function：

- 前端：登录按钮、图片选择/拖拽、预览、上传状态、结果复制。
- Edge Function：GitHub OAuth 登录、Session Cookie、身份校验、图片校验和 GitHub Contents API 调用。
- GitHub App：新建专用 App，只安装到 `image-bed`，使用 Contents 写权限；不使用权限范围更大的 OAuth App `public_repo`。
- GitHub 仓库：保存 `images/YYYY/MM/` 下的图片。
- jsDelivr：通过 `https://cdn.jsdelivr.net/gh/cyz-domo/image-bed@main/...` 分发图片。

不把 GitHub Client Secret、access token 或 Session 签名密钥放入前端代码。

## 数据流

1. 未登录用户可以访问历史列表；上传区和上传接口要求登录。
2. 需要上传时，前端请求 `/api/auth/login`。
3. Function 生成随机 `state`，写入短期 HttpOnly Cookie，并重定向到 GitHub 授权页。
4. GitHub 回调 `/api/auth/callback?code=...&state=...`。
5. Function 校验 `state`，确认用户为 `cyz-domo`，并通过 GitHub App 获取仅针对 `image-bed` 的安装令牌。
6. Function 签发 24 小时有效的 HttpOnly、Secure、SameSite=Lax Session Cookie。
7. 前端把图片以 `multipart/form-data` POST 到 `/api/upload`。
8. Function 校验 Session、文件类型、文件大小和文件头，压缩图片并生成随机文件名。
9. Function 调用 GitHub Contents API 创建文件，返回 GitHub 路径、jsDelivr URL 和 Markdown。

## API 约定

- `GET /api/auth/login`：开始 OAuth 登录。
- `GET /api/auth/callback`：处理 GitHub 回调并跳回首页。
- `GET /api/auth/me`：返回当前登录状态和用户名。
- `POST /api/upload`：接收单张图片并返回链接。
- `POST /api/auth/logout`：清除 Session Cookie。
- `GET /api/history`：读取并缓存公开仓库中的图片路径，按最新优先分页返回；允许匿名访问。

统一返回 JSON 错误对象，至少包含稳定的 `code` 和面向用户的 `message`。未登录返回 401，账号不匹配返回 403，文件校验失败返回 400，GitHub API 或上游故障返回 502。

## 安全与限制

- OAuth `state` 必须一次性使用并设置过期时间，防止 CSRF。
- Session 只保存最小身份信息；安装令牌由服务端保管，Cookie 使用 HttpOnly、Secure、SameSite=Lax，生命周期 24 小时。
- GitHub App 只安装到 `image-bed`，只授予 Contents 写权限。
- 只允许 PNG、JPG/JPEG、GIF、WebP；禁止 SVG。扩展名、MIME 和文件头三层校验必须一致。
- 原始单文件大小上限为 10 MB；不设置固定上传数量上限，但记录 GitHub API 异常并正确返回 429/502。
- 普通图片限制最长边并转为 WebP，目标体积约 300–500 KB；GIF 保留 GIF。超过压缩策略仍无法控制大小时拒绝上传。
- 生成随机文件名，避免暴露本地路径信息；同名情况由随机名天然规避。
- 不在响应、日志或前端状态中输出 access token 和 Client Secret。
- 历史列表缓存 5 分钟，避免匿名访问直接耗尽 GitHub API 配额；历史仅提供查看和复制，不提供删除或覆盖。

## 本地脚本

修复 `upload-image.sh` 的参数过长问题：不再把图片 Base64 作为 `gh` 命令行参数传递，改用请求体或临时 JSON 文件调用 GitHub API。脚本继续支持多文件上传、日期目录和 Markdown 输出，并沿用随机文件名策略。

## 部署配置

提供 `.env.example` 和部署说明，包含：

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_INSTALLATION_ID`
- `SESSION_SECRET`
- `GITHUB_OWNER=cyz-domo`
- `GITHUB_REPO=image-bed`
- `ALLOWED_GITHUB_LOGIN=cyz-domo`
- `MAX_FILE_SIZE=10485760`
- `HISTORY_CACHE_TTL=300`

GitHub OAuth App 的 Authorization callback URL 必须与 EdgeOne 生产域名完全一致。部署后使用生产域名验证登录、拒绝其他账号、上传、重复文件名、超限文件和登出流程。

## 验证标准

- 未登录不能上传。
- 未登录可以分页查看公开历史，但不能访问上传接口。
- `cyz-domo` 登录成功并能看到上传界面。
- 其他 GitHub 账号被拒绝。
- 正常图片能写入正确日期目录并返回可访问的 jsDelivr 链接。
- 普通图片输出 WebP，GIF 保持 GIF，压缩结果符合大小策略。
- 超限、非图片和异常文件名被拒绝。
- Client Secret、access token 和 Session Secret 不出现在构建产物和页面源码中。
- 本地脚本可上传大于当前参数限制的图片，并输出正确链接。
