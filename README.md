# image-bed

个人图床：网页上传，图片存到 GitHub 仓库，通过 [jsDelivr](https://www.jsdelivr.com/) CDN 公开访问。部署在腾讯云 [EdgeOne Pages](https://edgeone.ai/document/160428830614245376)（静态前端 + Cloud Functions API），自定义域名 `images.6143443.xyz`。

- **上传**：仅 `ALLOWED_GITHUB_LOGIN` 指定的 GitHub 账号（OAuth 登录后上传）
- **查看**：公开。任何人不登录也能访问图片链接和图片库
- **处理**：PNG/JPEG/WebP 在服务端缩放（最长边 ≤2560）并转 WebP；GIF 保留原格式；按文件真实字节校验格式（扩展名不符的图也能传）

## 站点结构

```
index.html / app.js / styles.css   纯静态前端（无框架、无构建）
  ├─ 首页标签：背景图 + 站点说明 + 上传面板（登录后显示）/ 登录引导（未登录显示）
  └─ 图片库标签：已上传图片网格，点击大图查看、一键复制链接
cloud-functions/
  ├─ _lib/auth.js   会话签发/校验（HMAC cookie）、GitHub App JWT、安装令牌
  ├─ _lib/http.js   JSON 响应（默认 no-store）、cookie 工具
  └─ api/
      ├─ auth/login|callback|me|logout.js   GitHub OAuth 登录流程
      ├─ upload.js     校验 → sharp 压缩转 WebP → GitHub Contents API 写入
      ├─ history.js    读仓库 git tree，列出 images/ 下的图片（内存缓存 5 分钟）
      └─ health.js     健康检查
```

## 环境变量

在 EdgeOne Pages 控制台 → 项目 → 环境变量配置（生效环境勾选 Production 和 Preview）：

| 变量 | 说明 |
|---|---|
| `GITHUB_APP_ID` | GitHub App 的数字 ID（App 设置页顶部） |
| `GITHUB_APP_CLIENT_ID` | App 的 Client ID（`Iv23li...`） |
| `GITHUB_APP_CLIENT_SECRET` | 生成 Client secret 得到 |
| `GITHUB_APP_INSTALLATION_ID` | App 安装到仓库后，安装页 URL 里的数字 ID |
| `GITHUB_APP_PRIVATE_KEY_B64_1/_2/_3` | 私钥 PEM **整个文件**的 base64，拆成三段（见下文） |
| `SESSION_SECRET` | 会话签名密钥，`openssl rand -hex 32` 生成 |
| `PUBLIC_BASE_URL` | `https://images.6143443.xyz`（OAuth 回调基于它构造） |
| `GITHUB_OWNER` / `GITHUB_REPO` | 图片仓库，如 `cyz-domo` / `image-bed` |
| `ALLOWED_GITHUB_LOGIN` | 允许上传的 GitHub 用户名 |
| `MAX_FILE_SIZE` | 上传大小上限，默认 10485760（10 MB） |
| `HISTORY_CACHE_TTL` | 历史列表缓存秒数，默认 300 |

### 私钥的三段式配置（重点）

EdgeOne 环境变量**上限 1000 字符**，而 GitHub App 私钥的 base64 约 2236 字符，单变量放不下，需要拆成三段（每段 <1000）。注意 base64 的对象是**整个 `.pem` 文件**（含 BEGIN/END 行），服务端会自动剥头、识别 PKCS#1/PKCS#8 并转换：

```bash
# 1. 整个 pem 转 base64（一行）
B64=$(base64 -i image-bed.*.private-key.pem | tr -d '\n')

# 2. 切成三段（700 + 700 + 余量），逐段复制
echo -n "${B64:0:700}"   | pbcopy   # → 粘贴到 GITHUB_APP_PRIVATE_KEY_B64_1
echo -n "${B64:700:700}" | pbcopy   # → 粘贴到 GITHUB_APP_PRIVATE_KEY_B64_2
echo -n "${B64:1400}"    | pbcopy   # → 粘贴到 GITHUB_APP_PRIVATE_KEY_B64_3
```

不配置带数字后缀的变量时，也可用单个 `GITHUB_APP_PRIVATE_KEY_B64`（本地开发/其他平台无长度限制时适用）。

> EdgeOne 控制台有时对较长粘贴值会提示"当前值不能为空"，多为粘贴未生效或超长被前端拦截——确认每段 <1000 字符、粘贴后输入框有值再保存。

## 从零部署到 EdgeOne Pages

1. **建图片仓库**：公开仓库（jsDelivr 只缓存公开仓库），即 `GITHUB_OWNER/GITHUB_REPO`。
2. **创建 GitHub App**（https://github.com/settings/apps/new）：
   - Homepage URL 填站点域名；勾选 **Request user authorization (OAuth) during installation** 及 Webhook 可留空/不勾；
   - Callback URL：`https://images.6143443.xyz/api/auth/callback`；
   - Repository permissions：**Contents: Read and write**；
   - 创建后记录 App ID、Client ID，生成 Client secret，**Generate a private key** 下载 `.pem`。
3. **安装 App 到图片仓库**，安装页 URL `https://github.com/apps/<app-name>/installations/<数字>` 中的数字即 Installation ID。
4. **EdgeOne Pages 控制台**：新建项目，关联本仓库 `main` 分支，push 即自动部署。
   - 构建命令留空即可（无前端打包步骤，`sharp` 由平台按 `package.json` 安装）；
   - Functions 运行时需支持 Node.js 依赖（Cloud Functions），不能选纯 Edge Functions（不支持 `sharp`）；
   - 按上表配置全部环境变量（含三段私钥）。
5. **部署后自检**：
   ```bash
   curl -s https://images.6143443.xyz/api/health
   curl -s https://images.6143443.xyz/api/auth/me        # {"authenticated":false}
   curl -sI https://images.6143443.xyz/api/auth/login    # 302 → github.com/login/oauth/authorize
   ```
6. **网页登录验证**：右上角"使用 GitHub 登录上传" → GitHub 授权 → 回站后右上角显示 `@用户名` 和退出按钮、首页出现上传面板。

### 踩坑记录（排障时先看这里）

- **所有 API 默认 `Cache-Control: no-store`**：边缘缓存曾把匿名时的 `/api/auth/me`"未登录"响应缓存住，导致登录成功仍显示未登录；OAuth 回调 302 也必须 `no-store`。
- **回调 302 只发一个 Set-Cookie**：该平台/前置代理层对带两个 Set-Cookie 的响应会丢 cookie，会话写不进浏览器。`oauth_state` 的清除挪到了 `/api/auth/me` 顺带完成。
- **上传按字节嗅探格式**：浏览器按扩展名上报 MIME，`.png` 实为 JPEG 的图曾触发魔数校验失败；现在以文件真实内容判定格式。
- **私钥是 PKCS#1**（`BEGIN RSA PRIVATE KEY`）：`crypto.subtle` 只认 PKCS#8，服务端已自动包装转换。

## 本地开发

```bash
npm install
npm run check   # 语法检查全部云函数
```

EdgeOne CLI 本地调试（读 `.env` 中的变量）：

```bash
npm install -g edgeone
edgeone login
edgeone makers link
edgeone makers dev      # http://localhost:8088/
```

## 命令行上传（备用）

不登录网页也可用 `gh` CLI 上传（原样保存，不转 WebP）：

```bash
bash upload-image.sh /path/to/image.png [more.png ...]
```

## 链接格式

```text
https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/images/YYYY/MM/<file>.webp
```

## 注意

- 仓库必须保持公开，jsDelivr 才能读取；图片公开可访问，**不要上传敏感内容**。
- jsDelivr 有缓存，同路径更新后可能短暂返回旧内容；本站上传使用随机文件名，天然规避。
- `.env`、`*.pem`、`images/` 已在 `.gitignore`，私钥只放 EdgeOne 环境变量。
- 如私钥泄露，在 GitHub App 设置页 Generate a new private key 换新，更新环境变量后重新部署即可。
