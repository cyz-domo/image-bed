const state = { page: 1, hasNext: false, tab: "home", heroUrl: null, loggedIn: false, login: null, galleryRequest: 0, heroRequest: 0, uploading: false, lightboxOpener: null, lightboxIndex: 0, lightboxPage: 1 };
const galleryPrefetches = new Map();
const GALLERY_CACHE_PREFIX = "image-bed.gallery.v2.";
const GALLERY_CACHE_TTL = 5 * 60 * 1000;
const GALLERY_CACHE_LIMIT = 6;
let activeHeroObjectUrl = null;
const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function api(path, options) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body;
}

let toastTimer = null;
function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) { toast = document.createElement("div"); toast.className = "toast"; document.body.appendChild(toast); }
  toast.textContent = message;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

async function copyText(text, button, recordPath) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { const input = document.createElement("textarea"); input.value = text; input.style.position = "fixed"; input.style.opacity = "0"; document.body.append(input); input.select(); if (!document.execCommand("copy")) throw new Error("复制失败"); input.remove(); }
    showToast("已复制到剪贴板");
    if (recordPath) api("/api/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: recordPath }) }).catch(() => {});
  } catch { showToast("复制失败，请检查剪贴板权限"); }
  finally { if (button) { button.disabled = false; button.classList.add("copied"); setTimeout(() => button.classList.remove("copied"), 700); } }
}

/* ---------- 账户 ---------- */
const SESSION_CACHE_KEY = "image-bed.session-hint";
function avatarFallback(login) { return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#e0e7ff"/><text x="32" y="39" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#4338ca">${(login || "?")[0].toUpperCase()}</text></svg>`)}`; }
function updateQuotaDisplay(remaining, limit) { const el = $("quota-status"); if (el && Number.isFinite(remaining)) { el.hidden = false; el.textContent = `今日剩余 ${remaining} / ${limit} 张`; } }
async function loadQuota() { try { const data = await api("/api/quota"); updateQuotaDisplay(data.remaining, data.limit); } catch { const el = $("quota-status"); if (el) { el.hidden = false; el.textContent = "今日额度暂不可用"; } } }

function renderLoggedIn(login, avatarUrl) {
  state.loggedIn = true;
  state.login = login;
  const account = $("account");
  account.classList.remove("hidden");
  const safeAvatar = /^https:\/\//.test(avatarUrl || "") ? avatarUrl : avatarFallback(login);
  account.innerHTML = `<button id="account-toggle" class="account-toggle" aria-label="账户菜单" aria-haspopup="true" aria-expanded="false"><img class="account-avatar" src="${escapeHtml(safeAvatar)}" alt="${escapeHtml(login)}" onerror="this.src='${avatarFallback(login)}';this.onerror=null"><span class="account-name">@${escapeHtml(login)}</span></button>`;
  $("upload-cta").classList.add("hidden");
  $("upload-panel").classList.remove("hidden");
  const toggle = $("account-toggle");
  toggle.onclick = (event) => { event.stopPropagation(); const panel = $("settings-panel"); panel.classList.toggle("hidden"); toggle.setAttribute("aria-expanded", String(!panel.classList.contains("hidden"))); };
  $("logout").onclick = async () => { localStorage.removeItem(SESSION_CACHE_KEY); invalidateGalleryCache(); await api("/api/auth/logout", { method: "POST" }); location.reload(); };
  loadSettings();
  loadQuota();
  if (state.tab === "gallery" && !$("gallery-login").classList.contains("hidden")) { $("gallery-login").classList.add("hidden"); loadGallery(); }
}

async function loadAccount() {
  const account = $("account");
  // 乐观渲染：按上次会话提示立即展示登录态，后台再向服务端确认
  let hint = null;
  try { hint = JSON.parse(localStorage.getItem(SESSION_CACHE_KEY) || "null"); } catch {}
  if (hint?.login) renderLoggedIn(hint.login, hint.avatarUrl);
  try {
    const data = await api("/api/auth/me");
    if (data.authenticated) {
      localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({ login: data.login, avatarUrl: data.avatar_url }));
      renderLoggedIn(data.login, data.avatar_url);
    } else {
      localStorage.removeItem(SESSION_CACHE_KEY);
      if (hint) location.reload(); // 乐观渲染错了（会话已失效），重来一次干净状态
    }
  } catch (error) {
    if (!hint) {
      account.innerHTML = '<a class="primary-button" href="/api/auth/login">登录</a>';
      console.warn("auth/me:", error.message);
    }
  }
}

// 背景图缓存：图片字节存 IndexedDB，按 URL 比对，只有设置变化时才重新下载
const HERO_DB = "image-bed-cache";
function heroDb() { return new Promise((resolve, reject) => { const open = indexedDB.open(HERO_DB, 1); open.onupgradeneeded = () => open.result.createObjectStore("kv"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); }); }
async function heroCacheGet(url) {
  try {
    const db = await heroDb();
    return await new Promise((resolve, reject) => { const tx = db.transaction("kv").objectStore("kv").get(url); tx.onsuccess = () => resolve(tx.result || null); tx.onerror = () => reject(tx.error); });
  } catch { return null; }
}
async function heroCachePut(url, blob) {
  try {
    const db = await heroDb();
    await new Promise((resolve, reject) => { const tx = db.transaction("kv", "readwrite").objectStore("kv").put(blob, url); tx.onsuccess = resolve; tx.onerror = reject; });
  } catch {}
}

async function heroCacheDelete(url) {
  if (!url) return;
  try { const db = await heroDb(); await new Promise((resolve) => { const tx = db.transaction("kv", "readwrite").objectStore("kv").delete(url); tx.onsuccess = resolve; tx.onerror = resolve; }); } catch {}
}

/* ---------- 站点设置（背景图） ---------- */
function applyHero(url, blob) {
  state.heroUrl = url;
  document.body.classList.toggle("has-hero", Boolean(url));
  if (activeHeroObjectUrl) { URL.revokeObjectURL(activeHeroObjectUrl); activeHeroObjectUrl = null; }
  if (url && blob) { activeHeroObjectUrl = URL.createObjectURL(blob); $("bg").style.backgroundImage = `url("${activeHeroObjectUrl}")`; }
  else if (!url) $("bg").style.backgroundImage = "";
  $("hero-remove").hidden = !url;
}

// 背景图对所有访客生效（GET /api/settings 公开）；字节缓存在浏览器 IndexedDB
async function loadHero(urlOverride) {
  const requestId = ++state.heroRequest;
  try {
    const url = urlOverride === undefined ? (await api("/api/settings")).settings.hero_background_url || null : urlOverride || null;
    if (requestId !== state.heroRequest) return;
    if (!url) { applyHero(null); return; }
    const cached = await heroCacheGet(url);
    if (requestId !== state.heroRequest) return;
    if (cached) { applyHero(url, cached); return; }
    const response = await fetch(url);
    if (!response.ok) throw new Error("背景图读取失败");
    const blob = await response.blob();
    if (requestId !== state.heroRequest) return;
    applyHero(url, blob);
    heroCachePut(url, blob);
  } catch { if (requestId === state.heroRequest && !state.heroUrl) applyHero(null); }
}

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    const s = data.settings || {};
    $("setting-hero-url").value = s.hero_background_url || "";
    $("setting-daily-limit").value = s.daily_upload_limit ?? data.defaults.daily_upload_limit;
    $("setting-max-size").value = s.max_file_mb ?? data.defaults.max_file_mb;
    const hint = `PNG、JPG、GIF、WebP，单张最大 ${Math.round(s.max_file_mb ?? data.defaults.max_file_mb)} MB`;
    $("dropzone-hint").textContent = hint;
  } catch { /* 设置读取失败不阻断页面 */ }
}

async function saveSettings() {
  const errorEl = $("setting-hero-error"); errorEl.hidden = true;
  const heroUrl = $("setting-hero-url").value.trim();
  if (heroUrl && !/^https:\/\//.test(heroUrl)) { errorEl.textContent = "需要 https:// 开头的图片地址"; errorEl.hidden = false; return; }
  try {
    const previousHeroUrl = state.heroUrl;
    const data = await api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hero_background_url: heroUrl, daily_upload_limit: Number($("setting-daily-limit").value), max_file_mb: Number($("setting-max-size").value) }) });
    if (previousHeroUrl && previousHeroUrl !== data.settings.hero_background_url) heroCacheDelete(previousHeroUrl);
    await loadHero(data.settings.hero_background_url || null);
    $("setting-daily-limit").value = data.settings.daily_upload_limit;
    $("setting-max-size").value = data.settings.max_file_mb;
    $("dropzone-hint").textContent = `PNG、JPG、GIF、WebP，单张最大 ${Math.round(data.settings.max_file_mb)} MB`;
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
      // XHR 以获得真实上传进度（大 GIF 不压缩时尤其需要）
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/upload");
        xhr.responseType = "json";
        xhr.upload.onprogress = (event) => { if (event.lengthComputable && payload.size > 512 * 1024) setStatus(`${file.name} 上传中 ${(event.loaded / 1048576).toFixed(1)}/${(event.total / 1048576).toFixed(1)} MB（${done + 1}/${total}）`); };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve(xhr.response) : reject(new Error(xhr.response?.message || `请求失败 (${xhr.status})`));
        xhr.onerror = () => reject(new Error("网络错误"));
        xhr.send(form);
      });
      $("upload-results").insertAdjacentHTML("beforeend", `<div class="result"><img src="${data.url}" alt=""><div class="result-info"><span class="url">${escapeHtml(data.url)}</span><div class="result-actions"><button class="icon-button" data-copy="${escapeHtml(data.url)}" title="复制链接" aria-label="复制链接">🔗</button><button class="icon-button" data-copy="${escapeHtml(data.markdown)}" title="复制 Markdown" aria-label="复制 Markdown">Ⓜ</button></div></div></div>`);
      $("upload-results").querySelectorAll("[data-copy]:not([data-bound])").forEach((button) => { button.dataset.bound = 1; button.onclick = async () => copyText(button.dataset.copy, button); });
      updateQuotaDisplay(data.daily_remaining, Number($("setting-daily-limit").value) || 100);
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
  if (!list.length || state.uploading) return;
  setStatus("");
  $("upload-results").innerHTML = "";
  const progress = $("upload-progress"); const bar = $("upload-progress-bar");
  progress.classList.remove("hidden");
  progress.setAttribute("aria-valuenow", "0");
  state.uploading = true;
  $("dropzone").classList.add("uploading");
  let done = 0, ok = 0;
  for (const file of list) {
    const success = await uploadOne(file, done, list.length);
    done += 1; if (success) ok += 1;
    const percent = Math.round((done / list.length) * 100);
    bar.style.width = `${percent}%`; progress.setAttribute("aria-valuenow", String(percent));
  }
  progress.classList.add("hidden");
  state.uploading = false; $("dropzone").classList.remove("uploading");
  setStatus(ok === list.length ? `全部完成（${ok} 张）` : `完成 ${ok} 张，失败 ${list.length - ok} 张`, ok !== list.length);
  $("results-footer").classList.toggle("hidden", !ok);
  if (ok) invalidateGalleryCache();
  if (state.tab === "gallery" && ok) loadGallery();
}
$("results-clear").onclick = () => { $("upload-results").innerHTML = ""; $("results-footer").classList.add("hidden"); setStatus(""); };
// 恢复上次每页设置（旧值可能是 3 的倍数，吸附到 4 的倍数）
try {
  const saved = Number(localStorage.getItem("image-bed.per-page"));
  if (saved >= 3) {
    const snapped = Math.min(120, Math.max(4, Math.round(saved / 4) * 4));
    $("per-page-input").value = snapped;
    localStorage.setItem("image-bed.per-page", String(snapped));
  }
} catch {}

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

function sortItems(items) {
  const list = [...items];
  const mode = $("gallery-sort")?.value || "newest";
  if (mode === "name") list.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  else if (mode === "oldest") list.reverse();
  return list; // newest 即接口默认顺序（新图在前）
}

function renderGallery(items) {
  state.pageItems = sortItems(items);
  const ordered = state.pageItems;
  // JS 分列瀑布流：按顺序放入当前最矮的列，保证视觉顺序从左到右
  const columnCount = window.matchMedia("(max-width: 560px)").matches ? 1 : window.matchMedia("(max-width: 860px)").matches ? 2 : 4;
  const columns = Array.from({ length: columnCount }, () => []);
  const heights = new Array(columnCount).fill(0);
  for (const item of ordered) {
    const target = heights.indexOf(Math.min(...heights));
    columns[target].push(item);
    heights[target] += 1; // 无固定比例，用张数近似均衡
  }
  const iconButtons = (item) => `
    <button class="icon-button" data-view="${item.url}" data-view-path="${escapeHtml(item.path)}" title="查看大图" aria-label="查看大图"><svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M2.5 7V4.5A2 2 0 0 1 4.5 2.5H7M13 2.5h2.5a2 2 0 0 1 2 2V7M17.5 13v2.5a2 2 0 0 1-2 2H13M7 17.5H4.5a2 2 0 0 1-2-2V13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    <button class="icon-button" data-copy="${escapeHtml(item.url)}" data-copy-path="${escapeHtml(item.path)}" title="复制链接" aria-label="复制链接"><svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M8.5 12.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1.5 1.5M11.5 7.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1.5-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    <button class="icon-button" data-copy="${escapeHtml(`![image](${item.url})`)}" data-copy-path="${escapeHtml(item.path)}" title="复制 Markdown" aria-label="复制 Markdown"><svg width="15" height="15" viewBox="0 0 20 20" fill="none"><rect x="1.5" y="4.5" width="17" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 12.5v-5l2.5 3 2.5-3v5M13 7.5v5M13 12.5l-1.8-1.8M13 12.5l1.8-1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  const card = (item) => selectMode()
    ? `<figure class="shot selectable${selection.has(item.path) ? " selected" : ""}" data-toggle="${escapeHtml(item.path)}"><img loading="lazy" src="${item.thumb || item.url}" alt="" /><span class="check${selection.has(item.path) ? " checked" : ""}" aria-hidden="true"></span></figure>`
    : `<figure class="shot"><img loading="lazy" src="${item.thumb || item.url}" alt="" /><figcaption class="shot-overlay">${iconButtons(item)}</figcaption></figure>`;
  $("gallery").innerHTML = columns.map((column) => `<div class="masonry-col">${column.map(card).join("")}</div>`).join("");
  $("gallery").querySelectorAll("[data-view]").forEach((button) => button.onclick = () => openLightbox(button.dataset.view, button.dataset.viewPath));
  $("gallery").querySelectorAll("[data-copy]").forEach((button) => button.onclick = async () => copyText(button.dataset.copy, button, button.dataset.copyPath));
  // 选择模式下点卡片任意位置切换选中
  if (selectMode()) $("gallery").querySelectorAll(".shot.selectable").forEach((node) => node.onclick = () => { const path = node.dataset.toggle; selection.has(path) ? selection.delete(path) : selection.add(path); renderGallery(state.pageItems); updateSelectionUi(); });
  updateSelectionUi();
}
$("gallery-sort").onchange = () => renderGallery(state.pageItems || []);
// 每页数量：自定义输入（4 的倍数，4-120，与桌面端 4 列瀑布流对齐），失焦或回车生效
function perPageValue() { const n = Math.round(Number($("per-page-input").value) / 4) * 4; return Math.min(120, Math.max(4, Number.isFinite(n) && n >= 4 ? n : 12)); }
function onPerPageChange() {
  const input = $("per-page-input");
  const snapped = perPageValue();
  input.value = snapped;
  try { localStorage.setItem("image-bed.per-page", String(snapped)); } catch {}
  if (snapped !== state.perPage) { state.perPage = snapped; state.page = 1; loadGallery(); }
}
$("per-page-input").onchange = onPerPageChange;
$("per-page-input").onkeydown = (event) => { if (event.key === "Enter") event.target.blur(); };

function galleryCacheKey(page, perPage) { return `${GALLERY_CACHE_PREFIX}${encodeURIComponent(state.login || "unknown")}.${perPage}.${page}`; }
function readGalleryCache(page, perPage) {
  try { const entry = JSON.parse(localStorage.getItem(galleryCacheKey(page, perPage)) || "null"); return entry && Array.isArray(entry.items) && Date.now() - entry.savedAt < GALLERY_CACHE_TTL ? entry : null; } catch { return null; }
}
function pruneGalleryCache() {
  try {
    const entries = Object.keys(localStorage).filter((key) => key.startsWith(GALLERY_CACHE_PREFIX)).map((key) => { try { return { key, savedAt: JSON.parse(localStorage.getItem(key)).savedAt || 0 }; } catch { return { key, savedAt: 0 }; } }).sort((a, b) => b.savedAt - a.savedAt);
    entries.forEach((entry, index) => { if (index >= GALLERY_CACHE_LIMIT || Date.now() - entry.savedAt >= GALLERY_CACHE_TTL) localStorage.removeItem(entry.key); });
  } catch {}
}
function writeGalleryCache(page, perPage, items, hasNext) { try { localStorage.setItem(galleryCacheKey(page, perPage), JSON.stringify({ savedAt: Date.now(), items, hasNext })); pruneGalleryCache(); } catch {} }
function invalidateGalleryCache() { try { Object.keys(localStorage).filter((key) => key.startsWith(GALLERY_CACHE_PREFIX) || key.startsWith("image-bed.gallery-page1.")).forEach((key) => localStorage.removeItem(key)); } catch {} galleryPrefetches.clear(); }
async function prefetchGallery(page, perPage) {
  const key = galleryCacheKey(page, perPage); if (readGalleryCache(page, perPage) || galleryPrefetches.has(key)) return;
  const task = api(`/api/history?page=${page}&per_page=${perPage}`).then((data) => writeGalleryCache(page, perPage, data.items, data.has_next)).catch(() => {}).finally(() => galleryPrefetches.delete(key));
  galleryPrefetches.set(key, task); await task;
}

async function loadGallery() {
  const requestId = ++state.galleryRequest;
  const perPage = perPageValue();
  $("gallery-login").classList.add("hidden");
  $("gallery-empty").classList.add("hidden");
  $("select-mode").classList.add("hidden");
  const cached = readGalleryCache(state.page, perPage);
  if (cached) { renderGallery(cached.items); state.hasNext = cached.hasNext; $("gallery-count").textContent = `本页 ${cached.items.length} 张`; $("previous").disabled = state.page === 1; $("next").disabled = !cached.hasNext; $("page-label").textContent = `第 ${state.page} 页`; $("select-mode").classList.toggle("hidden", !cached.items.length); }
  else $("gallery").innerHTML = '<div class="skeleton" style="height:220px"></div><div class="skeleton" style="height:160px"></div><div class="skeleton" style="height:200px"></div>';
  try {
    const data = await api(`/api/history?page=${state.page}&per_page=${perPage}`);
    if (requestId !== state.galleryRequest) return;
    const items = data.items;
    state.hasNext = data.has_next;
    $("previous").disabled = state.page === 1; $("next").disabled = !state.hasNext;
    $("page-label").textContent = `第 ${state.page} 页`;
    $("gallery-count").textContent = items.length ? `本页 ${items.length} 张` : "";
    writeGalleryCache(state.page, perPage, items, data.has_next);
    if (data.has_next) { const nextPage = state.page + 1; const schedule = window.requestIdleCallback || ((callback) => setTimeout(callback, 150)); schedule(() => prefetchGallery(nextPage, perPage)); }
    renderGallery(items);
    $("select-mode").classList.toggle("hidden", !items.length);
    if (!items.length && state.page > 1) { state.page -= 1; loadGallery(); return; }
    if (!items.length) { $("gallery").innerHTML = ""; $("gallery-empty").classList.remove("hidden"); }
  } catch (error) {
    if (requestId !== state.galleryRequest) return;
    if (cached) { setStatusQuiet(); return; }
    if (error.message.includes("登录")) { $("gallery").innerHTML = ""; $("gallery-login").classList.remove("hidden"); }
    else $("gallery").innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`;
  }
}
function setStatusQuiet() { $("gallery-count").textContent = `${(state.pageItems || []).length} 张（缓存）`; }

async function deleteSelected() {
  const paths = [...selection];
  if (!paths.length) return;
  if (!confirm(`确定删除选中的 ${paths.length} 张图片？删除后链接立即失效。`)) return;
  $("delete-selected").disabled = true;
  // 每 5 张一批、多批串行，规避平台函数执行时长限制与 GitHub API 压力
  const deleted = [], failed = [];
  for (let i = 0; i < paths.length; i += 5) {
    $("delete-selected").textContent = `删除中（${Math.min(i + 5, paths.length)}/${paths.length}）……`;
    try {
      const data = await api("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: paths.slice(i, i + 5) }) });
      deleted.push(...(data.deleted || [])); failed.push(...(data.failed || []));
    } catch (error) { failed.push(...paths.slice(i, i + 5).map((path) => ({ path, message: error.message }))); }
  }
  if (failed.length) alert(`${deleted.length} 张已删除，${failed.length} 张失败：\n${failed.map((f) => `${f.path}：${f.message}`).join("\n")}`);
  selection.clear(); if (deleted.length) invalidateGalleryCache(); await loadGallery();
}

/* ---------- 大图查看 ---------- */
async function getGalleryPage(page, perPage) {
  const cached = readGalleryCache(page, perPage);
  if (cached) return { items: cached.items, has_next: cached.hasNext, cached: true };
  const key = galleryCacheKey(page, perPage);
  if (galleryPrefetches.has(key)) return galleryPrefetches.get(key);
  const task = api(`/api/history?page=${page}&per_page=${perPage}`).then((data) => { writeGalleryCache(page, perPage, data.items, data.has_next); return data; }).finally(() => galleryPrefetches.delete(key));
  galleryPrefetches.set(key, task); return task;
}
async function navigateLightbox(direction) {
  if (state.lightboxLoading) return;
  const items = state.lightboxItems || [];
  if (direction > 0 && state.lightboxIndex < items.length - 1) { state.lightboxIndex += 1; updateLightbox(); return; }
  if (direction < 0 && state.lightboxIndex > 0) { state.lightboxIndex -= 1; updateLightbox(); return; }
  const page = state.lightboxPage + direction; if (page < 1 || (direction > 0 && !state.lightboxHasNext)) return;
  state.lightboxLoading = true; updateLightboxControls();
  try { const data = await getGalleryPage(page, state.lightboxPerPage); if (!data.items.length) throw new Error("没有更多图片"); state.lightboxPage = page; state.lightboxItems = data.items; state.lightboxHasNext = data.has_next; state.lightboxIndex = direction > 0 ? 0 : data.items.length - 1; updateLightbox(); } catch { showToast("加载更多图片失败"); } finally { state.lightboxLoading = false; updateLightboxControls(); }
}
function updateLightboxControls() { $("lightbox-prev").disabled = state.lightboxLoading || (state.lightboxIndex <= 0 && state.lightboxPage <= 1); $("lightbox-next").disabled = state.lightboxLoading || (state.lightboxIndex >= (state.lightboxItems || []).length - 1 && !state.lightboxHasNext); }

function openLightbox(url, path) {
  const items = state.pageItems || [], index = items.findIndex((item) => item.path === path || item.url === url);
  if (index < 0) { showToast("图片不在当前页面"); return; }
  state.lightboxItems = items; state.lightboxPage = state.page; state.lightboxPerPage = perPageValue(); state.lightboxHasNext = state.hasNext; state.lightboxIndex = index; state.lightboxOpener = document.activeElement; updateLightbox(); $("lightbox").classList.remove("hidden"); $("lightbox-close").focus();
}
function updateLightbox() {
  const item = (state.lightboxItems || [])[state.lightboxIndex]; if (!item) return; const url = item.url, path = item.path;
  const image = $("lightbox-image"), status = $("lightbox-status"), token = (state.lightboxImageToken = (state.lightboxImageToken || 0) + 1); image.src = ""; image.hidden = true; status.hidden = false; status.textContent = state.lightboxLoading ? "正在加载更多图片…" : "图片加载中…";
  image.onload = () => { if (token === state.lightboxImageToken) { image.hidden = false; status.hidden = true; } }; image.onerror = () => { if (token === state.lightboxImageToken) { status.hidden = false; status.textContent = "图片加载失败，请稍后重试"; } }; image.src = url; image.alt = path || "预览图片"; $("lightbox-url").textContent = url; $("lightbox-index").textContent = `${state.lightboxPage} 页 · ${state.lightboxIndex + 1} / ${state.lightboxItems.length}`; updateLightboxControls(); $("lightbox-copy").onclick = async () => copyText(url, $("lightbox-copy"), path); $("lightbox-copy-md").onclick = async () => copyText(`![image](${url})`, $("lightbox-copy-md"), path); $("lightbox-open").href = url; $("lightbox-delete").style.display = state.loggedIn ? "" : "none"; $("lightbox-delete").onclick = () => deleteImage(url, path);
}
async function deleteImage(url, knownPath) {
  if (!confirm("确定删除这张图片？删除后链接立即失效。")) return;
  $("lightbox-delete").disabled = true; $("lightbox-delete").textContent = "删除中……";
  try {
    // 优先用列表带的真实仓库路径；从 URL 推导仅作兜底（剥掉 jsDelivr 的 gh/owner/repo@main 前缀）
    const derived = decodeURIComponent(new URL(url).pathname.replace(/^\//, "")).replace(/^gh\/[^/]+\/[^/]+@[^/]+\//, "");
    const data = await api("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [knownPath || derived] }) });
    const targetPath = knownPath || derived;
    if (!(data.deleted || []).includes(targetPath) || (data.failed || []).some((item) => item.path === targetPath)) throw new Error(data.failed?.find((item) => item.path === targetPath)?.message || "图片删除未完成");
    invalidateGalleryCache(); closeLightbox(); loadGallery();
  } catch (error) { alert(`删除失败：${error.message}`); }
  finally { $("lightbox-delete").disabled = false; $("lightbox-delete").textContent = "删除"; }
}
function closeLightbox() { $("lightbox-image").src = ""; $("lightbox").classList.add("hidden"); state.lightboxOpener?.focus?.(); state.lightboxOpener = null; }
$("lightbox-close").onclick = closeLightbox;
$("lightbox-prev").onclick = () => navigateLightbox(-1);
$("lightbox-next").onclick = () => navigateLightbox(1);
document.addEventListener("keydown", (event) => { if (event.key !== "Tab" || $("lightbox").classList.contains("hidden")) return; const focusable = [...$("lightbox").querySelectorAll("button, a[href]")].filter((node) => !node.disabled && node.offsetParent !== null); if (!focusable.length) return; const index = focusable.indexOf(document.activeElement); const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1); event.preventDefault(); focusable[next].focus(); });
document.addEventListener("keydown", (event) => { if (!$("lightbox").classList.contains("hidden")) { if (event.key === "ArrowLeft") { event.preventDefault(); navigateLightbox(-1); } if (event.key === "ArrowRight") { event.preventDefault(); navigateLightbox(1); } } if (event.key === "Escape") { if (!$("lightbox").classList.contains("hidden")) closeLightbox(); if (!$("settings-panel").classList.contains("hidden")) { $("settings-panel").classList.add("hidden"); $("account-toggle")?.setAttribute("aria-expanded", "false"); $("account-toggle")?.focus(); } } });

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
$("file-input").onchange = (event) => { const files = [...event.target.files]; event.target.value = ""; if (files.length) upload(files); };
// 剪贴板粘贴上传：任何位置 Ctrl/Cmd+V 粘贴截图或复制的图片
document.addEventListener("paste", (event) => {
  if (!state.loggedIn) return;
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  switchTab("home");
  const named = files.map((file, index) => new File([file], file.name || `剪贴板图片-${Date.now()}-${index + 1}.png`, { type: file.type }));
  upload(named);
});
$("dropzone").ondragover = (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); };
$("dropzone").ondragleave = () => $("dropzone").classList.remove("dragging");
$("dropzone").ondrop = (event) => { event.preventDefault(); $("dropzone").classList.remove("dragging"); if (event.dataTransfer.files.length) upload(event.dataTransfer.files); };
$("setting-save").onclick = saveSettings;
$("hero-remove").onclick = async () => { $("setting-hero-url").value = ""; await saveSettings(); };
document.addEventListener("click", (event) => { if (!$("settings-panel").contains(event.target) && !$("account-toggle")?.contains(event.target)) { $("settings-panel").classList.add("hidden"); $("account-toggle")?.setAttribute("aria-expanded", "false"); } });
$("previous").onclick = () => { state.page -= 1; loadGallery(); };
$("next").onclick = () => { state.page += 1; loadGallery(); };

loadAccount();
loadHero();
// 初始进入：switchTab 会按登录态分流图片库；但 loadAccount 尚未返回，
// 先假设未登录显示引导卡片，loadAccount 确认登录后（若停在图片库）再真正加载
switchTab(location.hash === "#gallery" ? "gallery" : "home");
