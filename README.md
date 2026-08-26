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
