# EdgeOne + GitHub OAuth 图床设计

## 目标

为 `cyz-domo/image-bed` 增加一个部署在 EdgeOne Pages 的网页上传入口。只有 GitHub 账号 `cyz-domo` 可以上传，图片写入公开 GitHub 仓库，并返回 jsDelivr CDN 地址和 Markdown 格式。

## 方案

采用单个 EdgeOne 项目承载静态前端和 Edge Function：

- 前端：登录按钮、图片选择/拖拽、预览、上传状态、结果复制。
- Edge Function：GitHub OAuth 登录、Session Cookie、身份校验、图片校验和 GitHub Contents API 调用。
- GitHub OAuth App：提供授权和 access token；仅申请 `public_repo` 权限。
- GitHub 仓库：保存 `images/YYYY/MM/` 下的图片。
- jsDelivr：通过 `https://cdn.jsdelivr.net/gh/cyz-domo/image-bed@main/...` 分发图片。

不把 GitHub Client Secret、access token 或 Session 签名密钥放入前端代码。

## 数据流

1. 未登录用户访问页面，前端请求 `/api/auth/login`。
2. Function 生成随机 `state`，写入短期 HttpOnly Cookie，并重定向到 GitHub 授权页。
3. GitHub 回调 `/api/auth/callback?code=...&state=...`。
4. Function 校验 `state`，用 Client Secret 换取 access token，再调用 GitHub 用户接口。
5. 仅当返回用户名为 `cyz-domo` 时签发短期 HttpOnly、Secure、SameSite=Lax Session Cookie。
6. 前端把图片以 `multipart/form-data` POST 到 `/api/upload`。
7. Function 校验 Session、文件类型、文件大小和文件名，生成日期目录及冲突避免后的路径。
8. Function 调用 GitHub Contents API 创建文件，返回 GitHub 路径、jsDelivr URL 和 Markdown。

## API 约定

- `GET /api/auth/login`：开始 OAuth 登录。
- `GET /api/auth/callback`：处理 GitHub 回调并跳回首页。
- `GET /api/auth/me`：返回当前登录状态和用户名。
- `POST /api/upload`：接收单张图片并返回链接。
- `POST /api/auth/logout`：清除 Session Cookie。

统一返回 JSON 错误对象，至少包含稳定的 `code` 和面向用户的 `message`。未登录返回 401，账号不匹配返回 403，文件校验失败返回 400，GitHub API 或上游故障返回 502。

## 安全与限制

- OAuth `state` 必须一次性使用并设置过期时间，防止 CSRF。
- Session 只保存最小身份信息；Token 由服务端保管，Cookie 使用 HttpOnly、Secure、SameSite=Lax。
- 仅允许 `cyz-domo`，并申请 `public_repo`，不申请完整 `repo`。
- 默认限制 PNG、JPG/JPEG、GIF、WebP、SVG，并限制单文件大小；具体数值作为环境变量配置，默认 10 MB。
- 文件名只保留安全字符，避免路径穿越；同名文件追加时间戳和随机后缀。
- 不在响应、日志或前端状态中输出 access token 和 Client Secret。

## 本地脚本

修复 `upload-image.sh` 的参数过长问题：不再把图片 Base64 作为 `gh` 命令行参数传递，改用请求体或临时 JSON 文件调用 GitHub API。脚本继续支持多文件上传、日期目录和 Markdown 输出。

## 部署配置

提供 `.env.example` 和部署说明，包含：

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`
- `GITHUB_OWNER=cyz-domo`
- `GITHUB_REPO=image-bed`
- `ALLOWED_GITHUB_LOGIN=cyz-domo`
- `MAX_FILE_SIZE=10485760`

GitHub OAuth App 的 Authorization callback URL 必须与 EdgeOne 生产域名完全一致。部署后使用生产域名验证登录、拒绝其他账号、上传、重复文件名、超限文件和登出流程。

## 验证标准

- 未登录不能上传。
- `cyz-domo` 登录成功并能看到上传界面。
- 其他 GitHub 账号被拒绝。
- 正常图片能写入正确日期目录并返回可访问的 jsDelivr 链接。
- 超限、非图片和异常文件名被拒绝。
- Client Secret、access token 和 Session Secret 不出现在构建产物和页面源码中。
- 本地脚本可上传大于当前参数限制的图片，并输出正确链接。

