# image-bed

个人图床，图片通过 [jsDelivr](https://www.jsdelivr.com/) CDN 访问。

## 上传图片

在本目录执行：

```bash
bash upload-image.sh /path/to/image.png
```

脚本会把图片归档到 `images/YYYY/MM/`，通过当前登录的 `gh` 上传到 GitHub，然后输出可直接粘贴的 Markdown 链接。

也支持一次上传多张图片：

```bash
bash upload-image.sh image-1.png image-2.jpg
```

## 链接格式

```text
https://cdn.jsdelivr.net/gh/cyz-domo/image-bed@main/images/YYYY/MM/filename.png
```

## 注意

- 仓库必须保持公开，jsDelivr 才能正常读取。
- 图片更新后，jsDelivr 可能会短暂缓存旧内容；建议使用新文件名，或等待缓存刷新。
- 不要上传敏感信息、个人证件或不适合公开传播的内容。

## EdgeOne Pages 网页版

项目包含 EdgeOne Makers 前端和 `cloud-functions/` API：未登录用户可以查看历史链接，只有 `cyz-domo` 可以上传。普通 PNG/JPEG/WebP 会在服务端缩放并转为 WebP，GIF 保留原格式。

部署前需要：

1. 创建 GitHub App，并只安装到 `cyz-domo/image-bed`。
2. 为 App 开启用户授权，回调地址设置为 `https://你的 EdgeOne 域名/api/auth/callback`。
3. 给 App 的 Repository permissions 授予 `Contents: Read and write`。
4. 在 EdgeOne 项目配置 `.env.example` 中的环境变量；私钥只放环境变量，不提交到仓库。
5. 在 EdgeOne Makers 创建项目，关联本仓库的 `main` 分支。
6. 构建命令填写 `npm ci`，构建输出目录填写项目根目录（`.`）；项目没有前端打包步骤。
7. Functions 选择支持 Node.js 依赖的 Cloud Functions 运行时，并启用根目录下的 `cloud-functions/` 文件系统路由。不要选择不支持 `sharp` 的纯 Edge Functions 运行时。
8. 在 Makers 的环境变量/密钥配置中逐项填入 `.env.example`，然后点击开始部署。

本地检查：

```bash
npm install
npm run check
```

Makers 的函数入口采用 `onRequest(context)`，当前代码已从 `context.env` 读取环境变量，路由对应 `cloud-functions/api/` 下的文件。

## EdgeOne CLI 本地开发

```bash
npm install -g edgeone
edgeone login
edgeone whoami
edgeone makers link
edgeone makers dev
```

本地服务默认地址为 `http://localhost:8088/`。开发完成后可使用：

```bash
edgeone makers deploy
```

如果当前环境不能打开登录浏览器，可以在控制台创建 API Token 后使用：

```bash
edgeone makers dev -t "$EDGEONE_API_TOKEN"
edgeone makers deploy -t "$EDGEONE_API_TOKEN"
```
