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
  const hero = $("hero");
  if (url) { hero.style.backgroundImage = `url("${url}")`; hero.hidden = false; document.body.classList.add("has-hero"); }
  else { hero.style.backgroundImage = ""; hero.hidden = true; document.body.classList.remove("has-hero"); }
}

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    applyHero(data.settings.hero_background_url || null);
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

/* ---------- 上传 ---------- */
function setStatus(message, error = false) {
  const el = $("upload-status"); el.textContent = message; el.className = `status${error ? " error" : ""}`;
}

async function upload(file) {
  setStatus(""); $("upload-results").innerHTML = "";
  const form = new FormData(); form.append("file", file);
  const progress = $("upload-progress"); const bar = $("upload-progress-bar");
  progress.classList.remove("hidden"); bar.style.width = "30%"; bar.classList.add("indeterminate");
  try {
    const data = await api("/api/upload", { method: "POST", body: form });
    bar.classList.remove("indeterminate"); bar.style.width = "100%";
    setTimeout(() => progress.classList.add("hidden"), 400);
    $("upload-results").innerHTML = `<div class="result"><img src="${data.url}" alt=""><div class="result-info"><span class="url">${escapeHtml(data.url)}</span><button class="ghost-button" data-copy="${escapeHtml(data.markdown)}">复制 Markdown</button></div></div>`;
    $("upload-results").querySelectorAll("[data-copy]").forEach((button) => button.onclick = async () => copyText(button.dataset.copy, button));
    setStatus("上传完成");
  } catch (error) {
    progress.classList.add("hidden");
    setStatus(error.message, true);
  }
}

/* ---------- 图片库 ---------- */
async function loadGallery() {
  $("gallery").innerHTML = '<div class="skeleton" style="height:220px"></div><div class="skeleton" style="height:160px"></div><div class="skeleton" style="height:200px"></div>';
  $("gallery-empty").classList.add("hidden");
  try {
    const data = await api(`/api/history?page=${state.page}`);
    const items = data.items;
    state.hasNext = data.has_next;
    $("previous").disabled = state.page === 1; $("next").disabled = !state.hasNext;
    $("page-label").textContent = `第 ${state.page} 页`;
    $("gallery-count").textContent = items.length ? `本页 ${items.length} 张` : "";
    $("gallery").innerHTML = items.map((item) => `<figure class="shot"><img loading="lazy" src="${item.url}" alt="" /><figcaption class="shot-overlay"><button class="ghost-button small" data-view="${item.url}">查看</button><button class="ghost-button small" data-copy="${escapeHtml(item.url)}">复制</button></figcaption></figure>`).join("");
    if (!items.length) { $("gallery").innerHTML = ""; $("gallery-empty").classList.remove("hidden"); }
    $("gallery").querySelectorAll("[data-view]").forEach((button) => button.onclick = () => openLightbox(button.dataset.view));
    $("gallery").querySelectorAll("[data-copy]").forEach((button) => button.onclick = async () => copyText(button.dataset.copy, button));
  } catch (error) { $("gallery").innerHTML = `<p class="status error">${escapeHtml(error.message)}</p>`; }
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
    await api("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
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
}
for (const node of document.querySelectorAll(".nav-link")) node.onclick = () => switchTab(node.dataset.tab);
$("empty-go").onclick = () => switchTab("home");

/* ---------- 事件绑定 ---------- */
$("file-input").onchange = (event) => { if (event.target.files[0]) upload(event.target.files[0]); };
$("dropzone").ondragover = (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); };
$("dropzone").ondragleave = () => $("dropzone").classList.remove("dragging");
$("dropzone").ondrop = (event) => { event.preventDefault(); $("dropzone").classList.remove("dragging"); if (event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]); };
$("setting-save").onclick = saveSettings;
$("hero-remove").onclick = async () => { $("setting-hero-url").value = ""; await saveSettings(); };
$("previous").onclick = () => { state.page -= 1; loadGallery(); };
$("next").onclick = () => { state.page += 1; loadGallery(); };

loadAccount();
switchTab(location.hash === "#gallery" ? "gallery" : "home");
if (location.hash === "#gallery") loadGallery();
