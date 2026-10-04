# 部署 image-bed 图床

通过 **GitHub 仓库 + 腾讯云 EdgeOne Pages**，把自己的图片存进 GitHub，用网页上传、生成公开链接，支持多用户与数据隔离。图片通过 jsDelivr（或自定义加速域名）分发。

本指南只要求在浏览器里点，只有私钥转 base64 一步另给了命令行写法。

## 前置条件

- 一个 GitHub 账号（管理员，也是唯一能改站点设置的人）。
- 一个 EdgeOne 账号，已开通 Pages。
- 一个**公开** GitHub 仓库存放图片——jsDelivr 只服务公开仓库。
- 一个访问地址。EdgeOne Pages 分配的地址可用，但推荐自己的域名：OAuth 回调地址必须与它完全一致，换域名就要回去改 GitHub App。

下文以 `images.example.com` 为站点地址、`my-name/my-images` 为图片仓库，部署时替换成自己的值。

代码仓库和图片仓库可以是同一个：本项目的 `dev-edgeone` 分支放代码（EdgeOne 绑定它自动部署），`main` 分支既放代码也放图片与状态。

## 开始操作

1. [Fork 仓库](#1-fork-仓库)
2. [创建 GitHub App](#2-创建-github-app)
3. [把 App 安装到图片仓库](#3-把-app-安装到图片仓库)
4. [准备变量清单](#4-准备变量清单)
5. [创建 EdgeOne Pages 项目并部署](#5-创建-edgeone-pages-项目并部署)
6. [部署后自检](#6-部署后自检)
7. [登录，成为管理员](#7-登录成为管理员)
8. [以后如何更新](#8-以后如何更新)

### 1. Fork 仓库

打开本仓库，点击右上角 **Fork**。创建页面上**取消勾选 Copy the main branch only**，把 `dev-edgeone` 分支一起带过来——`main` 是图片与状态的存放分支，`dev-edgeone` 是 EdgeOne 的部署分支，两个都不能少。

如果已经 Fork 完、发现只有 `main`，在 Fork 的仓库里补一个：文件列表上方的分支下拉 → New branch → 名为 `dev-edgeone`，基于 `main` 创建即可。之后第 5 步的自动部署会把它更新成最新代码。

### 2. 创建 GitHub App

图床用 GitHub App（而不是普通 OAuth App）换取仓库写权限，这样浏览器才能把大文件直接上传到你的仓库。

打开 [创建 GitHub App 页面](https://github.com/settings/apps/new)：

| 表单项 | 填写内容 |
| --- | --- |
| GitHub App name | 自己的应用名，例如 `my-image-bed` |
| Homepage URL | `https://images.example.com` |
| Callback URL | `https://images.example.com/api/auth/callback` |
| Setup URL | 可留空 |
| Webhook → Active webhook | **不勾选** |
| Request user authorization (OAuth) during installation | **必须勾选**，否则用户授权后拿不到会话 |
| Repository permissions → Contents | **Read and write** |
| Account permissions → Email addresses | Read-only（可选） |

最后一项只在打算用"邮箱"匹配用户名单时才需要；用 GitHub 用户名匹配就不用勾，也少一处权限。

点击 **Create application**，进入应用详情页后依次记下：

1. 页面顶部的数字 **App ID** → `GITHUB_APP_ID`
2. **Client ID**（`Iv23li...` 开头）→ `GITHUB_APP_CLIENT_ID`
3. **Generate a new client secret** → 立刻复制 → `GITHUB_APP_CLIENT_SECRET`（离开页面后就看不全了）
4. **Generate a private key** → 下载 `*.private-key.pem`（第 4 步要用）

**⚠️ 必做：把 App 设为公开。** 在 App 的 General 设置页 → About 区域 → **Make public**。

> 私有 App 只有 App 所有者能看到。别人点"使用 GitHub 登录"时，GitHub 会返回 **Page not found · `/login/oauth/authorize`**，表现就是新用户根本登不进来。这是全站最容易踩的坑。

### 3. 把 App 安装到图片仓库

在 App 页面左侧 **Install Application**，选择 **Only select repositories**，选中 `my-name/my-images`，安装。

安装完成后浏览器会停在安装页，地址形如：

```text
https://github.com/apps/my-image-bed/installations/12345678
```

末尾的数字即 `GITHUB_APP_INSTALLATION_ID`。

### 4. 准备变量清单

EdgeOne Pages 只有一处环境变量（不像有些平台分构建时与运行时），所以只需要**一份清单**。

在 Fork 的仓库根目录打开 [.env.example](../.env.example)，点 **Raw** 复制内容，存成电脑上的文本文件，跟着后面的步骤逐项补值，最后整份填进 EdgeOne 控制台。

| 变量 | 示例 / 从哪里获取 | 作用 |
| --- | --- | --- |
| `GITHUB_APP_ID` | 第 2 步记下的数字 ID | 换取安装令牌 |
| `GITHUB_APP_CLIENT_ID` | 第 2 步的 Client ID | GitHub 登录应用标识 |
| `GITHUB_APP_CLIENT_SECRET` | 第 2 步生成的 secret | GitHub 登录交换令牌 |
| `GITHUB_APP_INSTALLATION_ID` | 第 3 步安装页 URL 末尾的数字 | 定位 App 装到了哪个仓库 |
| `GITHUB_APP_PRIVATE_KEY_B64_1/_2/_3` | 第 2 步 `.pem` 的 base64，切三段 | 签名换令牌；大文件直传要用 |
| `SESSION_SECRET` | 自己生成的随机串（见下） | 签名登录 cookie，并用于折算用户标识 |
| `PUBLIC_BASE_URL` | `https://images.example.com` | OAuth 回调基于它构造，必须与访问地址一致 |
| `GITHUB_OWNER` / `GITHUB_REPO` | `my-name` / `my-images` | 图片仓库 |
| `ALLOWED_GITHUB_LOGIN` | 你自己的 GitHub 用户名 | **管理员**，始终拥有全部权限 |
| `ALLOWED_USERS` | 其他可用用户，逗号分隔 | 推荐配置，见第 7 步 |
| `MAX_FILE_SIZE` | `10485760`（10 MB） | 单张上限的**默认值**，单位为字节 |
| `DAILY_UPLOAD_LIMIT` | `100` | 每用户每日张数的**默认值** |

`SESSION_SECRET` 可以用密码管理器生成 64 位随机字符。也可以在任意可信 HTTPS 页面打开浏览器开发者工具的 Console（控制台），执行下面这段，复制结果（不含两侧引号）：

```js
Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
  n.toString(16).padStart(2, "0"),
).join("");
```

`MAX_FILE_SIZE` 与 `DAILY_UPLOAD_LIMIT` 只是兜底：管理员在**设置 → 存储**里保存过值之后就以站点设置为准，再改环境变量不生效。

#### 私钥为什么要切三段

EdgeOne 的**单个环境变量值上限 1000 字符**，而 `.pem` 文件整体 base64 后约 2236 字符，必须切成三段、每段 <1000。base64 的对象是**整个 `.pem` 文件**（含 `BEGIN/END` 行），服务端会自动剥头并识别 PKCS#1 / PKCS#8。

命令行（macOS / Linux / WSL）：

```bash
B64=$(base64 -i my-image-bed.*.private-key.pem | tr -d '\n')
echo -n "${B64:0:700}"   | pbcopy   # → GITHUB_APP_PRIVATE_KEY_B64_1
echo -n "${B64:700:700}" | pbcopy   # → GITHUB_APP_PRIVATE_KEY_B64_2
echo -n "${B64:1400}"    | pbcopy   # → GITHUB_APP_PRIVATE_KEY_B64_3
```

手边没有命令行时，在任意 HTTPS 页面的 Console 里执行下面这段，浏览器会弹出文件选择框，选中那个 `.pem`，控制台按 `---` 分隔打印出三段：

```js
const input = document.createElement("input");
input.type = "file";
input.onchange = async () => {
  const bytes = new Uint8Array(await input.files[0].arrayBuffer());
  const b64 = btoa(String.fromCharCode(...bytes));
  console.log(`${b64.slice(0, 700)}\n---\n${b64.slice(700, 1400)}\n---\n${b64.slice(1400)}`);
};
input.click();
```

本地开发或其他没有长度限制的平台，可以改用单个 `GITHUB_APP_PRIVATE_KEY_B64`（完整 base64）；三段变量只是绕过 EdgeOne 的 1000 字符限制。

### 5. 创建 EdgeOne Pages 项目并部署

1. EdgeOne 控制台新建 Pages 项目，关联 Fork 仓库的 **`dev-edgeone` 分支**——此后每次 push 该分支都会自动部署。
2. **构建命令留空**：前端是原生 ES Modules，没有打包步骤；`sharp` 由平台按 `package.json` 安装。
3. 函数运行时选 **Cloud Functions**。**不能选纯 Edge Functions**——它加载不了 `sharp`，所有 `/api/*` 会 502。
4. 按第 4 步的清单填写环境变量，**生效环境同时勾选 Production 和 Preview**。
5. 域名：绑定自定义域名，或先用平台分配的地址。地址变了要回去同步改 `PUBLIC_BASE_URL` 和 GitHub App 的 Callback URL。
6. 保存配置后重新部署一次，让变量进入运行时。

### 6. 部署后自检

push 后等约 1–3 分钟，在浏览器里逐个打开三个地址，返回都应是预期值：

| 打开 | 预期 |
| --- | --- |
| `https://images.example.com/api/health` | `{"ok":true,"missing":[]}`；`missing` 非空说明变量没读到，接口返回 503 |
| `https://images.example.com/api/auth/me` | `{"authenticated":false, ...}` |
| `https://images.example.com/api/auth/login` | 跳到 GitHub 的 `login/oauth/authorize` 页面 |

`/api/health` 响应里的 `build` 字段（`short` / `time` / `fingerprint`）是线上代码的构建指纹。改完代码 push 后刷新它，**指纹变了才说明这次部署真的上线了**——静态资源有缓存，光看页面容易误判。

再确认三处地址的域名完全一致，任何一个不一致都会在登录时卡住：

```text
浏览器访问地址：              https://images.example.com
PUBLIC_BASE_URL：            https://images.example.com
GitHub App Callback URL：    https://images.example.com/api/auth/callback
```

### 7. 登录，成为管理员

用自己的 GitHub 账号打开站点，点 **使用 GitHub 登录** → 授权 → 回到站点即为管理员。管理员能改站点设置、管理用户名单、看到全部用户的图片。

**给别人开权限**有两种做法，推荐第一种：

- **环境变量 `ALLOWED_USERS`**（推荐）：逗号分隔的 GitHub 用户名或公开邮箱。图片仓库是 public 的，写在站点设置里的名单任何人都能从 `.state/state.json` 取到；用环境变量名单不落进仓库，而且配置后当场覆盖仓库里的旧名单。改完需重新部署生效。
- **设置 → 用户**（仅管理员可见）：适合频繁增减、且不在意名单被读到的场合。已配置 `ALLOWED_USERS` 时这一页变成只读，并提示到控制台修改。

不在名单内的账号能完成 GitHub 授权，但会被站点拒绝，看不到任何图片。普通用户只能看到和删除自己上传的内容，每日配额各自独立计算。

### 8. 以后如何更新

代码在 `dev-edgeone` 分支上改，本地验证后 push，约 1–3 分钟自动部署：

```bash
npm run check     # 语法检查，末尾盖上构建指纹
npm test          # Node 内置测试
git push origin dev-edgeone
```

上游本仓库出了新版本时，在 Fork 的仓库里把 `dev-edgeone` 切到 **Sync fork → Update branch**，自动部署跟着触发；`main`（图片数据分支）不受影响。

## 可选配置

先跑通基本部署，再按需添加。

| 功能 | 怎么开 | 说明 |
| --- | --- | --- |
| 图片加速域名 | 管理员 **设置 → 存储 → 图片加速域名** | 填自己的 jsDelivr 反代域名；留空即用 `cdn.jsdelivr.net` |
| KV 存储 | 控制台开通 KV → 创建 Namespace → 项目里 Bind Namespace，**环境变量名必须为 `IMAGE_KV`** | 未绑定时状态写进仓库 `.state/state.json`，上传/退出会各产生一条 `chore: update state` 提交。每日配额要求该 KV 提供原子 `incr`/`increment`，否则配额接口返回 503。本项目线上**没有使用 KV**，走的就是仓库文件这条路 |
| 分区 | 上传时选择或新建分区名 | 文件存入 `images/<分区>/<年>/<月>/`；每个分区可单独设"保留原图"跳过压缩 |
| 背景图与主题 | 管理员 **设置 → 外观** | 背景图、模糊度、浅色 / 深色 / 跟随系统 |
| CLI 直传 | `edgeone makers deploy --env production` | **仅限纯静态预览**：实测云函数加载 `sharp` 会 502，且直传不继承环境变量。完整功能必须走 git 分支部署 |

## 常见问题

### 别人点登录，GitHub 显示 Page not found

GitHub App 还是私有状态。去 App 的 General 设置页 → **Make public**，不需要重新部署。这是最常见的一条。

### 授权完回到站点，仍然显示未登录

按顺序核对：三处域名是否完全一致（见第 6 步）；App 是否勾选了 **Request user authorization (OAuth) during installation**；站点是否通过 **HTTPS** 访问（会话 cookie 带 `Secure`，纯 HTTP 存不住）。

### 所有 `/api/*` 都返回 502

函数运行时选成了纯 Edge Functions，或这次部署是 CLI 直传上来的——两种情况都加载不了 `sharp`。改用 git 分支部署 + Cloud Functions 运行时。

### `/api/health` 返回 503，`missing` 里有变量名

对应变量没读到。检查变量名拼写、值前后是否混入空格、是否只勾了 Preview 而访问的是 Production。`missing` 出现 `GITHUB_APP_PRIVATE_KEY` 时，多半是三段私钥少配了一段，或某段超过 1000 字符被截断。

### 粘贴私钥时控制台提示"当前值不能为空"

EdgeOne 控制台对长粘贴值偶发误报。确认每段 <1000 字符、输入框里确有值再保存；必要时先清空输入框再粘贴。

### 上传大图或视频时报 500、页面变函数崩溃页

EdgeOne 函数请求体上限 **6 MB**。压缩后仍超过 5 MB 的图片与所有视频本应由浏览器**直传** GitHub API，不经过云函数；如果仍报 500，先用 `/api/health` 的 `build` 确认线上是带直传逻辑的版本，再看文件是否超过 20 MB。

### 链接提示 File size exceeded 20 MB

jsDelivr 的单文件分发上限是 20 MB。文件已经存进仓库，但 CDN 取不到——删掉，换更小的版本。

### 新用户登录后图片库是空的

预期行为：数据按用户隔离，每个人只看自己上传的。分区列表在打开图片库或首次上传后自动建立。

### 邮箱白名单匹配不到用户

GitHub 的 `/user` 接口通常不返回邮箱。要么在 App 开启 **Email addresses: Read-only** 权限并重新安装 App，要么改用 GitHub 用户名匹配——用户名唯一且稳定，推荐。

### 上传或退出后，图片仓库多了一条 `chore: update state` 提交

未绑定 `IMAGE_KV` 时的预期行为：状态存在仓库 `.state/state.json`。不绑定也能正常用，只是提交历史会变脏。

### 改了 `dev-edgeone` 并 push，页面没变化

确认项目绑定的分支确实是 `dev-edgeone`、这次构建成功；再用 `/api/health` 的 `build` 字段核对线上指纹。注意：只改 `edgeone.json` 里的响应头不会改变指纹，这类改动要看静态资源响应头中的版本标记。

## 注意事项

- **仓库必须公开**，jsDelivr 才能读取；图片链接对任何拿到地址的人都可访问，不要上传敏感内容。
- 图片仓库 public 意味着 `.state/` 与图片文件本身也能被人直接取到。登录只挡住界面与数据隔离展示，**不构成字节级访问控制**；要真正做到只能本人取用，需要私有仓库加带鉴权的回源代理。
- **单文件 ≤20 MB**（jsDelivr 上限）。
- `.env`、`*.pem`、`images/` 已在 `.gitignore`，私钥只放 EdgeOne 环境变量，绝不提交。
- 私钥泄露时：在 App 设置页 **Generate a new private key** 换新，更新三段环境变量并重新部署，旧密钥即刻失效。
- 直传用的 GitHub 安装令牌约 1 小时有效，只签发给名单内已登录用户，权限限于图片仓库的 Contents 读写。

---

[返回项目 README](../README.md)
