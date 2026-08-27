const state = { page: 1, hasNext: false, tab: "home", heroUrl: null, loggedIn: false };
const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function api(path, options) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body;
}

async function copyText(text, button) {
  await navigator.clipboard.writeText(text);
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original; button.textContent = "已复制";
  setTimeout(() => { button.textContent = original; }, 1500);
}

/* ---------- 账户 ---------- */
async function loadAccount() {
  const account = $("account");
  try {
    const data = await api("/api/auth/me");
    if (data.authenticated) {
      state.loggedIn = true;
      account.innerHTML = `<span class="account-name">@${escapeHtml(data.login)}</span><button id="logout" class="ghost-button">退出</button>`;
      $("upload-cta").classList.add("hidden");
      $("upload-panel").classList.remove("hidden");
      $("settings").classList.remove("hidden");
      $("logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); };
      loadSettings();
      if (state.tab === "gallery" && $("gallery-login").classList.contains("hidden") === false) { $("gallery-login").classList.add("hidden"); loadGallery(); }
    } else {
      account.innerHTML = '<a class="primary-button" href="/api/auth/login">登录</a>';
    }
  } catch (error) {
    account.innerHTML = `<a class="primary-button" href="/api/auth/login">登录</a>`;
    console.warn("auth/me:", error.message);
  }
}

/* ---------- 站点设置（背景图） ---------- */
function applyHero(url) {
  state.heroUrl = url;
  document.body.classList.toggle("has-hero", Boolean(url));
  $("bg").style.backgroundImage = url ? `url("${url}")` : "";
  $("hero-remove").hidden = !url;
}

// 背景图对所有访客生效（GET /api/settings 公开）
async function loadHero() {
  try {
    const data = await api("/api/settings");
    applyHero(data.settings.hero_background_url || null);
  } catch { /* 读取失败就用默认背景 */ }
}

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    $("setting-hero-url").value = data.settings.hero_background_url || "";
  } catch { /* 设置读取失败不阻断页面 */ }
}

async function saveSettings() {
  const errorEl = $("setting-hero-error"); errorEl.hidden = true;
  const value = $("setting-hero-url").value.trim();
  if (value && !/^https:\/\//.test(value)) { errorEl.textContent = "需要 https:// 开头的图片地址"; errorEl.hidden = false; return; }
  try {
    const data = await api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hero_background_url: value }) });
    applyHero(data.settings.hero_background_url || null);
  } catch (error) { errorEl.textContent = error.message; errorEl.hidden = false; }
}

/* ---------- 上传（支持批量，并发 2） ---------- */
function setStatus(message, error = false) {
  const el = $("upload-status"); el.textContent = message; el.className = `status${error ? " error" : ""}`;
}

// 上传前本地压缩：长边压到 2560、WebP 质量 0.85（浏览器不支持 WebP 编码时退 JPEG），比原文件小才采用
async function compressForUpload(file) {
  if (file.type === "image/gif" || file.size < 200 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
    if (!blob || blob.type !== "image/webp") blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    const extension = blob.type === "image/webp" ? ".webp" : ".jpg";
    return new File([blob], file.name.replace(/\.\w+$/, "") + extension, { type: blob.type });
  } catch { return file; }
}

async function uploadOne(file, done, total) {
  setStatus(`正在处理 ${file.name}（${done + 1}/${total}）……`);
  const payload = await compressForUpload(file);
  if (payload !== file) setStatus(`已压缩 ${file.name}（${(file.size / 1048576).toFixed(1)} MB → ${(payload.size / 1048576).toFixed(1)} MB），上传中……`);
  const form = new FormData(); form.append("file", payload);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const data = await api("/api/upload", { method: "POST", body: form });
      $("upload-results").insertAdjacentHTML("beforeend", `<div class="result"><img src="${data.url}" alt=""><div class="result-info"><span class="url">${escapeHtml(data.url)}</span><button class="ghost-button" data-copy="${escapeHtml(data.markdown)}">复制 Markdown</button></div></div>`);
      const button = $("upload-results").querySelector(`[data-copy="${CSS.escape(data.markdown)}"]:not([data-bound])`);
      if (button) { button.dataset.bound = 1; button.onclick = async () => copyText(button.dataset.copy, button); }
      return true;
    } catch (error) {
      // 平台偶发的请求体竞态（503 UPLOAD_RETRY）自动重试
      if (error.message.includes("重试") && attempt < 4) { await new Promise((resolve) => setTimeout(resolve, 500 * attempt)); continue; }
      $("upload-results").insertAdjacentHTML("beforeend", `<div class="result failed"><span class="url error">${escapeHtml(file.name)}：${escapeHtml(error.message)}</span></div>`);
      return false;
    }
  }
}

async function upload(files) {
  const list = [...files];
  setStatus(""); $("upload-results").innerHTML = "";
  const progress = $("upload-progress"); const bar = $("upload-progress-bar");
  progress.classList.remove("hidden");
  let done = 0, ok = 0;
  const queue = [...list];
  const worker = async () => { while (queue.length) { const file = queue.shift(); const success = await uploadOne(file, done, list.length); done += 1; if (success) ok += 1; bar.style.width = `${Math.round((done / list.length) * 100)}%`; } };
  await worker(); // 串行上传：规避平台并发请求体的竞态问题
  progress.classList.add("hidden");
  setStatus(ok === list.length ? `全部完成（${ok} 张）` : `完成 ${ok} 张，失败 ${list.length - ok} 张`, ok !== list.length);
  if (state.tab === "gallery" && ok) loadGallery();
}

/* ---------- 图片库（含批量管理） ---------- */
const selection = new Set();
const selectMode = () => state.selectMode === true;

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) { selection.clear(); }
  for (const id of ["select-mode", "select-exit"]) $(id).classList.toggle("hidden", on !== (id === "select-exit"));
  for (const id of ["select-all", "delete-selected"]) $(id).classList.toggle("hidden", !on);
  updateSelectionUi();
  if (state.pageItems) renderGallery(state.pageItems);
}

function updateSelectionUi() {
  $("delete-selected").textContent = `删除选中${selection.size ? `（${selection.size}）` : ""}`;
  $("delete-selected").disabled = selection.size === 0;
  $("select-all").textContent = selection.size && selection.size === (state.pageItems || []).length ? "取消全选" : "全选";
}

function renderGallery(items) {
  state.pageItems = items;
  // JS 分列瀑布流：按顺序放入当前最矮的列，保证视觉顺序从左到右
  const columnCount = window.matchMedia("(max-width: 560px)").matches ? 1 : window.matchMedia("(max-width: 860px)").matches ? 2 : 3;
  const columns = Array.from({ length: columnCount }, () => []);
  const heights = new Array(columnCount).fill(0);
  for (const item of items) {
    const target = heights.indexOf(Math.min(...heights));
    columns[target].push(item);
    heights[target] += 1; // 无固定比例，用张数近似均衡
  }
  const card = (item) => selectMode()
    ? `<figure class="shot selectable${selection.has(item.path) ? " selected" : ""}"><img loading="lazy" src="${item.url}" alt="" data-path="${escapeHtml(item.path)}" /><figcaption class="shot-overlay"><button class="ghost-button small" data-toggle="${escapeHtml(item.path)}">${selection.has(item.path) ? "取消选择" : "选择"}</button></figcaption><span class="check" aria-hidden="true"></span></figure>`
    : `<figure class="shot"><img loading="lazy" src="${item.url}" alt="" /><figcaption class="shot-overlay"><button class="ghost-button small" data-view="${item.url}">查看</button><button class="ghost-button small" data-copy="${escapeHtml(item.url)}">复制</button></figcaption></figure>`;
  $("gallery").innerHTML = columns.map((column) => `<div class="masonry-col">${column.map(card).join("")}</div>`).join("");
  $("gallery").querySelectorAll("[data-view]").forEach((button) => button.onclick = () => openLightbox(button.dataset.view));
  $("gallery").querySelectorAll("[data-copy]").forEach((button) => button.onclick = async () => copyText(button.dataset.copy, button));
  $("gallery").querySelectorAll("[data-toggle]").forEach((button) => button.onclick = () => { const path = button.dataset.toggle; selection.has(path) ? selection.delete(path) : selection.add(path); renderGallery(state.pageItems); updateSelectionUi(); });
  // 选择模式下点图片本身也可切换
  if (selectMode()) $("gallery").querySelectorAll(".shot.selectable img").forEach((img) => img.onclick = () => { const path = img.dataset.path; selection.has(path) ? selection.delete(path) : selection.add(path); renderGallery(items); updateSelectionUi(); });
  updateSelectionUi();
}

async function loadGallery() {
  $("gallery-login").classList.add("hidden");
  $("gallery").innerHTML = '<div class="skeleton" style="height:220px"></div><div class="skeleton" style="height:160px"></div><div class="skeleton" style="height:200px"></div>';
  $("gallery-empty").classList.add("hidden");
  if (!selectMode()) setSelectMode(false);
  try {
    const data = await api(`/api/history?page=${state.page}`);
    const items = data.items;
    state.hasNext = data.has_next;
    $("previous").disabled = state.page === 1; $("next").disabled = !state.hasNext;
    $("page-label").textContent = `第 ${state.page} 页`;
    $("gallery-count").textContent = items.length ? `本页 ${items.length} 张` : "";
    $("select-mode").classList.remove("hidden");
    renderGallery(items);
    if (!items.length) { $("gallery").innerHTML = ""; $("gallery-empty").classList.remove("hidden"); $("select-mode").classList.add("hidden"); }
  } catch (error) {
    if (error.message.includes("登录")) { $("gallery").innerHTML = ""; $("gallery-login").classList.remove("hidden"); }
    else $("gallery").innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
}

async function deleteSelected() {
  const paths = [...selection];
  if (!paths.length) return;
  if (!confirm(`确定删除选中的 ${paths.length} 张图片？删除后链接立即失效。`)) return;
  $("delete-selected").disabled = true; $("delete-selected").textContent = "删除中……";
  try {
    const data = await api("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) });
    if (data.failed_count) alert(`${data.deleted.length} 张已删除，${data.failed_count} 张失败：\n${data.failed.map((f) => `${f.path}：${f.message}`).join("\n")}`);
    selection.clear(); await loadGallery();
  } catch (error) { alert(`删除失败：${error.message}`); }
  finally { $("delete-selected").disabled = false; updateSelectionUi(); }
}

/* ---------- 大图查看 ---------- */
function openLightbox(url) {
  $("lightbox-image").src = url; $("lightbox-url").textContent = url;
  $("lightbox-copy").onclick = async () => copyText(url, $("lightbox-copy"));
  $("lightbox-open").href = url;
  $("lightbox-delete").style.display = state.loggedIn ? "" : "none";
  $("lightbox-delete").onclick = () => deleteImage(url);
  $("lightbox").classList.remove("hidden");
}
async function deleteImage(url) {
  if (!confirm("确定删除这张图片？删除后链接立即失效。")) return;
  $("lightbox-delete").disabled = true; $("lightbox-delete").textContent = "删除中……";
  try {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    await api("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [path] }) });
    closeLightbox(); loadGallery();
  } catch (error) { alert(`删除失败：${error.message}`); }
  finally { $("lightbox-delete").disabled = false; $("lightbox-delete").textContent = "删除"; }
}
function closeLightbox() { $("lightbox-image").src = ""; $("lightbox").classList.add("hidden"); }
$("lightbox-close").onclick = closeLightbox;
document.querySelector(".lightbox-backdrop").onclick = closeLightbox;
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("lightbox").classList.contains("hidden")) closeLightbox(); });

/* ---------- 标签页 ---------- */
function switchTab(tab) {
  state.tab = tab;
  for (const node of document.querySelectorAll(".nav-link")) node.classList.toggle("active", node.dataset.tab === tab);
  $("page-home").classList.toggle("hidden", tab !== "home");
  $("page-gallery").classList.toggle("hidden", tab !== "gallery");
  history.replaceState(null, "", tab === "home" ? "/" : "/#gallery");
  if (tab === "gallery") {
    // 先按当前登录态分流，未登录不发起列表请求
    if (state.loggedIn) loadGallery();
    else { $("gallery").innerHTML = ""; $("gallery-login").classList.remove("hidden"); }
  }
}
for (const node of document.querySelectorAll(".nav-link")) node.onclick = () => switchTab(node.dataset.tab);
$("empty-go").onclick = () => switchTab("home");
$("select-mode").onclick = () => setSelectMode(true);
$("select-exit").onclick = () => setSelectMode(false);
$("select-all").onclick = () => { const items = state.pageItems || []; const all = items.length && items.every((item) => selection.has(item.path)); if (all) items.forEach((item) => selection.delete(item.path)); else items.forEach((item) => selection.add(item.path)); renderGallery(items); updateSelectionUi(); };
$("delete-selected").onclick = deleteSelected;

/* ---------- 事件绑定 ---------- */
$("file-input").onchange = (event) => { if (event.target.files.length) upload(event.target.files); };
$("dropzone").ondragover = (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); };
$("dropzone").ondragleave = () => $("dropzone").classList.remove("dragging");
$("dropzone").ondrop = (event) => { event.preventDefault(); $("dropzone").classList.remove("dragging"); if (event.dataTransfer.files.length) upload(event.dataTransfer.files); };
$("setting-save").onclick = saveSettings;
$("hero-remove").onclick = async () => { $("setting-hero-url").value = ""; await saveSettings(); };
$("previous").onclick = () => { state.page -= 1; loadGallery(); };
$("next").onclick = () => { state.page += 1; loadGallery(); };

loadAccount();
loadHero();
// 初始进入：switchTab 会按登录态分流图片库；但 loadAccount 尚未返回，
// 先假设未登录显示引导卡片，loadAccount 确认登录后（若停在图片库）再真正加载
switchTab(location.hash === "#gallery" ? "gallery" : "home");
