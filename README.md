# image-bed

个人 GitHub 图床：网页上传，图片保存到 GitHub 仓库，并生成公开可访问的图片链接。部署在腾讯云 [EdgeOne Pages](https://edgeone.ai/document/160428830614245376)（静态前端 + Cloud Functions API），可绑定自定义域名（示例：`images.example.com`）。

- **上传**：仅 `ALLOWED_GITHUB_LOGIN` 指定的 GitHub 账号（OAuth 登录后上传），每日上限 `DAILY_UPLOAD_LIMIT`（默认 100 张），支持 PNG/JPG/GIF/WebP 图片与 MP4 视频，支持在图片库删除已传内容
- **视频直传**：EdgeOne 函数请求体上限 6MB，因此视频由浏览器持 GitHub 安装令牌（约 1 小时有效，仅签发给已登录管理员，上限 100MB/个）**直接 PUT 到 GitHub API**，函数只负责签发凭证、校验文件存在并登记历史；封面由浏览器截帧后同令牌直传
- **分区**：上传时可选择或直接输入新分区名（首个文件上传时自动创建）；图片存储在 `images/<分区名>/年/月/` 下，图片库可按分区筛选。分区名支持中文、字母、数字、连字符（1–32 位，不能是纯 4 位数字）；不填分区即为默认图床，历史图片路径不变
- **图片链接**：公开可访问。任何人只要拥有链接即可查看图片，请勿上传敏感内容
- **图片库**：仅登录用户可见，用于浏览、排序、复制链接和删除图片
- **会话**：HMAC 签名 cookie，有效期 24 小时；退出登录时服务端吊销会话，丢失的 cookie 无法再次登入
- **状态存储**：优先 EdgeOne KV（绑定变量名 `IMAGE_KV`，见下文）；未绑定时回退到仓库 `.state/state.json`（会因此产生少量 `chore: update state` 提交）
- **历史列表**：图片列表缓存在 KV 中（10 分钟），所有边缘实例共享，跨实例访问不再回源 GitHub；上传/删除会同步更新缓存。未绑定 KV 时退回单实例内存缓存
- **处理**：PNG/JPEG/WebP 在服务端缩放（最长边 ≤2560）并转 WebP；GIF 保留原格式；按文件真实字节校验格式（扩展名不符的图也能传）

## 页面与目录结构

当前前端为原生 ES Modules、无构建步骤的静态页面：

```text
index.html / app.js / styles.css   页面入口、交互逻辑与 Apple 风格视觉系统
fonts/                              自托管开源字体 Noto Sans SC（SIL OFL，三档字重）
logo.jpg                            顶栏品牌 Logo 与社交分享预览图（约 18 KB）
favicon.ico                        网站图标（64×64，约 6 KB）
favicon.svg                        SVG 备用图标
cloud-functions/                   EdgeOne Cloud Functions API
  ├─ _lib/                         鉴权、GitHub、状态、HTTP 工具
  └─ api/                          OAuth、上传、图片库、删除、设置、健康检查
scripts/deploy-cli.sh              直传部署 staging 打包脚本
tests/                              Node 内置测试
```

首页采用 Hero + 登录 CTA/上传主面板；图片库提供登录后浏览、排序、批量管理、分页、复制和 Lightbox；设置浮层提供背景图、加速域名、额度和三态主题。

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
| `PUBLIC_BASE_URL` | `https://images.example.com`（OAuth 回调基于它构造） |
| `GITHUB_OWNER` / `GITHUB_REPO` | 图片仓库，如 `cyz-domo` / `image-bed` |
| `ALLOWED_GITHUB_LOGIN` | 允许上传的 GitHub 用户名 |
| `MAX_FILE_SIZE` | 上传大小上限，默认 10485760（10 MB） |
| `DAILY_UPLOAD_LIMIT` | 每日上传张数上限，默认 100，超过后当天返回 429 |

### KV 存储（推荐配置）

状态数据（会话吊销名单、每日上传计数、站点设置、历史列表缓存）优先存放在 EdgeOne KV 中，未绑定 KV 时自动回退到仓库 `.state/state.json`（会在仓库产生少量 `chore: update state` 提交）。切换到 KV：

1. EdgeOne 控制台 → 存储空间（KV）→ 开通账户（免费额度 1GB）；
2. 创建 Namespace（名称随意，如 `image-bed`）；
3. 项目详情 → KV Storage → Bind Namespace，**环境变量名必须为 `IMAGE_KV`**；每日配额要求该 KV 同时提供原子 `incr` 或 `increment` 方法，否则上传接口会在配额服务不可用时返回 503，避免并发绕过上限；
4. 重新部署后生效。KV 为最终一致；配额计数使用按日期的原子键，吊销状态读取失败时敏感接口会 fail-closed。

绑定 KV 的收益：上传/退出不再产生仓库提交；历史列表在所有边缘实例间共享缓存（10 分钟），`/api/history` 冷实例也快。

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
   - Callback URL：`https://images.example.com/api/auth/callback`；
   - Repository permissions：**Contents: Read and write**；
   - 创建后记录 App ID、Client ID，生成 Client secret，**Generate a private key** 下载 `.pem`。
3. **安装 App 到图片仓库**，安装页 URL `https://github.com/apps/<app-name>/installations/<数字>` 中的数字即 Installation ID。
4. **EdgeOne Pages 控制台**：新建项目，关联本仓库的 **`dev-edgeone` 分支**，push 该分支即自动部署。
   - 构建命令留空即可（无前端打包步骤，`sharp` 由平台按 `package.json` 安装）；
   - Functions 运行时需支持 Node.js 依赖（Cloud Functions），不能选纯 Edge Functions（不支持 `sharp`）；
   - 按上表配置全部环境变量（含三段私钥）。
5. **部署后自检**：
   ```bash
   curl -s https://images.example.com/api/health
   curl -s https://images.example.com/api/auth/me        # {"authenticated":false}
   curl -sI https://images.example.com/api/auth/login    # 302 → github.com/login/oauth/authorize
   ```
6. **网页登录验证**：右上角"使用 GitHub 登录上传" → GitHub 授权 → 回站后右上角显示 `@用户名` 和退出按钮、首页出现上传面板。

### 踩坑记录（排障时先看这里）

- **所有 API 默认 `Cache-Control: no-store`**：边缘缓存曾把匿名时的 `/api/auth/me`"未登录"响应缓存住，导致登录成功仍显示未登录；OAuth 回调 302 也必须 `no-store`。
- **回调 302 只发一个 Set-Cookie**：该平台/前置代理层对带两个 Set-Cookie 的响应会丢 cookie，会话写不进浏览器。`oauth_state` 的清除挪到了 `/api/auth/me` 顺带完成。
- **上传按字节嗅探格式**：浏览器按扩展名上报 MIME，`.png` 实为 JPEG 的图曾触发魔数校验失败；现在以文件真实内容判定格式。
- **私钥是 PKCS#1**（`BEGIN RSA PRIVATE KEY`）：`crypto.subtle` 只认 PKCS#8，服务端已自动包装转换。

## 分支与部署策略

- `main`：开发主线，普通 push 不触发正式 EdgeOne 部署。
- `dev-edgeone`：EdgeOne Pages 绑定分支，push 后自动部署（通常约 1–2 分钟）。
- 网页上传/删除图片由 GitHub App 提交到图片仓库的 `main`，与 EdgeOne 部署分支无关。
- 将开发主线同步到部署分支：

```bash
git push origin main:dev-edgeone
```

推荐流程：先在 `main` 完成功能开发和检查，再将经过验证的提交推送到 `dev-edgeone`。

### 用 CLI 部署（推荐）

EdgeOne CLI（`npm install -g edgeone`，已登录腾讯云账号）支持两种部署方式：

**方式一：git 分支触发**（正式项目 `image-bed` 是 GitHub 绑定型，CLI 直传不支持，但推分支即部署）：

```bash
git push origin main:dev-edgeone   # 同步 main → dev-edgeone，自动部署
```

**方式二：CLI 直传**（创建/更新直传型项目，不需要 git 仓库）：

```bash
# 项目已 link（.edgeone/project.json 存在）时：
edgeone makers deploy --env production

# 新项目：--name 指定项目名，同时支持 --json 输出（适合脚本/Agent 消费）
edgeone makers deploy --name <project-name> --env production --json
```

直传部署要点：

- **只打包必要文件**：直传会把目录下所有文件传上去。至少排除 `.env`（含密钥）、`node_modules`、`images/`、`.git`。推荐建一个干净的 staging 目录再部署（见 `scripts/deploy-cli.sh`）。
- 部署成功返回**带 `eo_token` 的预览 URL**（`*.edgeone.cool` 域名），URL 直接访问会 401/302，需要浏览器访问种下 cookie 后才能继续访问；正式域名（自定义域名）不受此限制。
- 直传项目**不继承**正式项目的环境变量，需要用 CLI 单独配置：`edgeone makers env set <KEY> <VALUE>`（在项目目录内执行，或 `link` 之后执行）。三段式私钥也可这样设置。
- **⚠️ 实测限制（2026-08）：直传型项目的云函数加载 `sharp` 会崩溃**（所有 `/api/*` 路由 502，错误页显示 "This function has crashed: ReferenceError"）。二分定位结论：不含 sharp 的函数、相对导入 `_lib`、`package.json`+sharp 依赖声明但函数不 import sharp，均正常；只要函数顶层或动态 `import("sharp")` 即崩溃。GitHub 绑定型项目（本项目正式部署方式）不受影响。因此 **CLI 直传只适合部署纯静态版本或做前端预览，完整功能必须走 git 分支部署**。
- CLI 没有删除项目的 API（只有 `DeletePagesProjectEnvs`），测试用的直传项目需到控制台手动删除。
- 本地 `edgeone makers dev` 会先做依赖同步与构建校验，可提前发现打包问题（本项目本地构建验证通过）。

### 部署后自检

```bash
curl -s https://images.example.com/api/health        # {"ok":true,"missing":[]}
curl -s https://images.example.com/api/auth/me       # {"authenticated":false}
curl -sI https://images.example.com/api/auth/login   # 302 → github.com/login/oauth/authorize
```

## 本地开发与测试

```bash
npm install
npm run dev       # 静态服务器，默认访问 http://localhost:8000/
npm test          # Node 内置测试
npm run check     # 前端入口与全部 Cloud Functions 语法检查
```

前端不需要构建命令；EdgeOne Pages 的构建命令保持为空。完整登录、上传和删除流程需要在已配置 OAuth、GitHub App 和 KV 的 EdgeOne 环境验证。

EdgeOne CLI 本地调试（读 `.env` 中的变量）：

```bash
npm install -g edgeone
edgeone login
edgeone makers link   # 或 edgeone makers dev -n <项目名>
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
