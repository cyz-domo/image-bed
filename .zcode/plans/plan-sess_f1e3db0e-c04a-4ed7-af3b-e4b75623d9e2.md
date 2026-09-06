## 实施计划：安全加固 + 明亮空气感前端重构

### 1. 建立可回滚的模块骨架

- 保留 `index.html` 的 `type="module"` 入口、根路径静态资源和所有 `/api/*` 请求契约。
- 从现有 `app.js` 提取 `modules/` 下的原生 ES Modules，所有相对导入显式使用 `.js`。
- 先抽出无 DOM 副作用的公共模块：
  - `modules/state.js`：共享 state、缓存常量、选择集合和主题存储键。
  - `modules/dom.js`：`$`、安全 URL 校验、`escapeHtml`（仅用于文本片段）、安全属性设置辅助函数。
  - `modules/api.js`：保留现有凭据、JSON 解析和错误语义。
  - `modules/ui.js`：Toast、确认 Modal、焦点保存/恢复、主题三态。
- 保持现有竞态字段（gallery/hero request id、lightbox token）、缓存 key 规则和跨页 lightbox 数据语义不变。

### 2. 先完成底层安全与可靠性修复

- 将账户头像、上传结果、图库卡片、Lightbox 原图链接等动态资源全部改为 DOM API 设置：创建元素后设置 `.src`、`.href`、`dataset`，不再把不可信 URL 插入 HTML 属性或 inline `onerror`。
- 对远程资源执行 HTTPS/URL 解析校验；失败时使用头像 SVG fallback或错误占位，不让 `javascript:`、引号和属性边界进入 DOM。
- 为设置表单增加 trim、非空、`Number.isFinite`、整数/小数和 min/max 校验，提交前显示字段级错误，避免空值变成 0。
- 将上传主流程包在 `try/finally`，无论压缩、XHR、DOM 插入或意外异常都恢复 `state.uploading`、dropzone class、进度条和按钮状态；保留当前串行上传及单文件失败继续策略。
- 登录初始化改为占位状态：服务端确认前不渲染完整账户菜单；服务端失败时展示可重试/登录状态，不用整页 reload 修正错误闪现。
- Hero 缓存继续使用 IndexedDB 和 object URL 生命周期，增加 TTL、条目数及近似字节上限的清理；开发环境记录可诊断错误，生产反馈保持安静。
- 保留已完成的 confirmAsync，完善确认框 Escape、焦点回收和批量删除多行错误显示；Toast 支持普通/错误时长、`aria-live` 和 `white-space: pre-line`。

### 3. 按职责拆分业务模块

- `modules/auth.js`：`loadAccount`、账户菜单、退出登录、quota 加载和认证后的 gallery/settings 初始化。
- `modules/settings.js`：设置读取/保存、字段校验、Hero IndexedDB 缓存、背景图加载/清理。
- `modules/upload.js`：压缩、XHR 上传/重试、文件选择、拖拽、粘贴及结果渲染；结果节点使用安全 DOM 构造。
- `modules/gallery.js`：排序、分页、localStorage 缓存/预取、Masonry 渲染、选择模式和批量删除；图片卡片使用键盘可达按钮/checkbox 语义。
- `modules/lightbox.js`：跨页预览、方向键、加载状态、复制、打开原图、单图删除和焦点陷阱。
- `app.js`：仅保留初始化、页面级 tab/hash 事件和模块组合；补充 `hashchange/popstate` 同步。
- 每次拆分后保持外部行为一致，再删除旧 app.js 中重复实现，避免双重事件监听。

### 4. 重构 HTML 语义与交互骨架

- 保留现有功能区域，但为 header/nav/main 补充明确标签关系；导航改为可访问 tab 语义，维护 `aria-selected`、`aria-controls` 和键盘切换。
- 文件输入从 `display:none` 改为 visually-hidden，保留 label 点击、键盘 focus-visible 和拖放区域。
- 设置面板从 `role="menu"` 改为设置区域/dialog 语义，补充标题关联、关闭行为和焦点处理。
- 为图库卡片加入文件名/路径等有意义的 alt；预览、选择和复制操作保持可聚焦且具备明确 aria-label。
- 更新 `theme-color` 与主题状态同步；补充基础 OG/Twitter Card 元信息。
- 确认 Modal 和 Lightbox 保持语义 dialog，打开时聚焦首个动作、关闭时恢复触发元素；移动端操作区改为稳定的纵向/换行布局。

### 5. 实现 A 方案视觉系统

- 重写 `styles.css` 的 token：`#f5f5f7` 系统背景、白色 surface、系统蓝强调色、中性边框/阴影、较大圆角和更宽松间距。
- 将背景渐变弱化为近白色冷灰光晕；保留自定义 Hero，但通过遮罩、层级和对比度避免背景干扰内容。
- 顶栏采用轻薄 sticky 毛玻璃；导航使用简洁胶囊/细线 active 状态；账户入口触控区域不小于 44px。
- 首页增强标题、留白和上传卡片层级；上传区使用低对比度虚线，拖入/focus 时以系统蓝强调。
- 图片库保留 Masonry，但避免固定 3:2 强制裁切（优先使用真实缩略图比例/`object-fit: contain` 的安全方案）；优化悬停、键盘和触摸操作呈现。
- 调整按钮、输入框、Modal、Toast、Lightbox 为一致的圆角、间距、阴影和动效，并保留 reduced-motion。
- 增加 860/560 之外的窄屏处理，确保图库工具、设置字段、分页和 Lightbox caption 在 400px 以下不拥挤。
- 主题使用 `system`/`light`/`dark` 三态 CSS 选择器，确保手动浅色覆盖系统深色，且初始脚本/属性应用减少闪烁。

### 6. 增加可测试的纯函数与测试

- 新增 `tests/`，使用现有 `node --test`，不引入前端框架或构建工具。
- 覆盖 URL 协议校验、设置数字校验、主题解析、缓存裁剪/键生成、上传状态恢复等纯逻辑。
- 对 API 错误解析和关键模块边界使用最小 mock；不依赖真实 EdgeOne、DOM 或 GitHub 凭据。
- 扩展 `npm run check` 覆盖新增前端模块及当前遗漏的 Cloud Functions 文件，保持 Node ESM 兼容。

### 7. 验证与文档同步

- 运行 `npm run check`、`npm test`，并修复所有失败。
- 启动本地静态服务器，验证登录占位、上传/批量上传/粘贴、图库分页排序、复制、Lightbox、单图/批量删除、背景设置、三态主题和窄屏布局。
- 检查 Git diff，确保 Cloud Functions API 契约、EdgeOne 配置和部署分支策略未改变。
- 更新 README 的前端模块结构、测试命令和部署说明；不把 Service Worker、国际化、框架迁移或后端图片变体生成混入本轮。
- 按阶段提交：安全可靠性修复、模块化重构、视觉与可访问性、测试文档；每阶段均可独立回滚。