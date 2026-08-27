# image-bed

个人图床：网页上传，图片存到 GitHub 仓库，通过 [jsDelivr](https://www.jsdelivr.com/) CDN 公开访问。部署在腾讯云 [EdgeOne Pages](https://edgeone.ai/document/160428830614245376)（静态前端 + Cloud Functions API），自定义域名 `images.6143443.xyz`。

- **上传**：仅 `ALLOWED_GITHUB_LOGIN` 指定的 GitHub 账号（OAuth 登录后上传），每日上限 `DAILY_UPLOAD_LIMIT`（默认 100 张），支持在图片库删除已传图片
- **查看**：公开。任何人不登录也能访问图片链接和图片库
- **会话**：HMAC 签名 cookie，有效期 24 小时；退出登录时服务端吊销会话，丢过的 cookie 无法再登入
- **状态存储**：优先 EdgeOne KV（绑定变量名 `IMAGE_KV`，见下文）；未绑定时回退到仓库 `.state/state.json`（会因此产生少量 `chore: update state` 提交）
- **历史列表**：图片列表缓存在 KV 中（10 分钟），所有边缘实例共享，跨实例访问不再回源 GitHub；上传/删除会同步更新缓存。未绑定 KV 时退回单实例内存缓存
- **处理**：PNG/JPEG/WebP 在服务端缩放（最长边 ≤2560）并转 WebP；GIF 保留原格式；按文件真实字节校验格式（扩展名不符的图也能传）

## 站点结构

```
index.html / app.js / styles.css   纯静态前端（无框架、无构建）
  ├─ 首页标签：背景图 + 站点说明 + 上传面板（登录后显示）/ 登录引导（未登录显示）
  └─ 图片库标签：已上传图片网格，点击大图查看、一键复制链接
cloud-functions/
  ├─ _lib/auth.js   会话签发/校验/吊销（HMAC cookie）、GitHub App JWT
  ├─ _lib/github.js GitHub API 封装 + 安装令牌缓存（45 分钟）
  ├─ _lib/state.js  状态存储：优先 KV（IMAGE_KV），回退 .state/state.json；含历史列表 KV 缓存
  └─ api/
      ├─ auth/login|callback|me|logout.js   GitHub OAuth 登录流程（退出即吊销）
      ├─ upload.js     限额检查 → 字节嗅探 → sharp 压缩转 WebP → GitHub 写入
      ├─ delete.js     删除已上传图片（仅 images/ 路径，需登录）
      ├─ settings.js   站点设置（背景图 URL 等；GET 公开，POST 需登录）
      ├─ history.js    图片列表（KV 共享缓存 10 分钟，未绑 KV 时回源 git tree）
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
| `DAILY_UPLOAD_LIMIT` | 每日上传张数上限，默认 100，超过后当天返回 429 |

### KV 存储（推荐配置）

状态数据（会话吊销名单、每日上传计数、站点设置、历史列表缓存）优先存放在 EdgeOne KV 中，未绑定 KV 时自动回退到仓库 `.state/state.json`（会在仓库产生少量 `chore: update state` 提交）。切换到 KV：

1. EdgeOne 控制台 → 存储空间（KV）→ 开通账户（免费额度 1GB）；
2. 创建 Namespace（名称随意，如 `image-bed`）；
3. 项目详情 → KV Storage → Bind Namespace，**环境变量名必须为 `IMAGE_KV`**（代码按此名读取，未绑定或不可用时自动回退，不会报错）；
4. 重新部署后生效。KV 为最终一致（跨节点最多延迟约 60 秒），对单人图床无感。

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

## 分支与部署策略

- `main`：开发主线。**EdgeOne 不跟踪此分支**，推送不触发自动部署；要上线时在 EdgeOne 控制台手动部署（选择 `main`）。
- `dev-edgeone`：EdgeOne 绑定的占位/预览分支，推此分支会自动部署。
- 网页上传/删除图片由 GitHub App 直接提交到 `main`（`chore: upload/delete ...`），与分支策略无关；如果云函数代码有未部署的变更，传图后记得手动部署。
- 把 `main` 的最新代码同步到 dev 分支：`git push origin main:dev-edgeone`。

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
