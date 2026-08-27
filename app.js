const state = { page: 1, hasNext: false, tab: "home" };
const $ = (id) => document.getElementById(id);

function setStatus(message, error = false) {
  const el = $("upload-status"); el.textContent = message; el.className = `status${error ? " error" : ""}`;
}

async function api(path, options) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body;
}

let loggedIn = false;
async function loadAccount() {
  const account = $("account");
  try {
    const data = await api("/api/auth/me");
    if (data.authenticated) {
      loggedIn = true;
      account.innerHTML = `<span>@${data.login}</span><button id="logout">退出</button>`;
      $("upload-cta").classList.add("hidden");
      $("upload-panel").classList.remove("hidden");
      $("logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); };
    } else account.innerHTML = '<a class="login" href="/api/auth/login">使用 GitHub 登录上传</a>';
  } catch (error) {
    account.innerHTML = `<a class="login" href="/api/auth/login">使用 GitHub 登录上传</a><p class="status error">${error.message}</p>`;
  }
}

async function copyText(text, button) {
  await navigator.clipboard.writeText(text);
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original; button.textContent = "已复制";
  setTimeout(() => { button.textContent = original; }, 1500);
}

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function loadGallery() {
  $("gallery").innerHTML = '<p class="subtle">正在加载……</p>';
  try {
    const data = await api(`/api/history?page=${state.page}`);
    const items = data.items;
    $("gallery").innerHTML = items.length
      ? items.map((item) => `<figure class="card"><img loading="lazy" src="${item.url}" alt="${escapeHtml(item.path)}" /><figcaption class="url" title="${escapeHtml(item.url)}">${escapeHtml(item.path)}</figcaption><div class="card-actions"><button data-view="${item.url}">查看</button><button data-copy="${escapeHtml(item.url)}">复制链接</button></div></figure>`).join("")
      : '<p class="subtle">暂无上传记录。</p>';
    state.hasNext = data.has_next; $("previous").disabled = state.page === 1; $("next").disabled = !state.hasNext; $("page-label").textContent = `第 ${state.page} 页`;
    $("gallery").querySelectorAll("[data-view]").forEach((button) => button.onclick = () => openLightbox(button.dataset.view));
    $("gallery").querySelectorAll("[data-copy]").forEach((button) => button.onclick = async () => copyText(button.dataset.copy, button));
  } catch (error) { $("gallery").innerHTML = `<p class="status error">${error.message}</p>`; }
}

function openLightbox(url) {
  $("lightbox-image").src = url; $("lightbox-url").textContent = url;
  $("lightbox-copy").onclick = async () => copyText(url, $("lightbox-copy"));
  $("lightbox-open").href = url;
  $("lightbox-delete").style.display = loggedIn ? "" : "none";
  $("lightbox-delete").onclick = () => deleteImage(url);
  $("lightbox").classList.remove("hidden");
}
async function deleteImage(url) {
  if (!confirm("确定删除这张图片？删除后链接立即失效。")) return;
  $("lightbox-delete").disabled = true; $("lightbox-delete").textContent = "删除中……";
  try {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    await api("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    $("lightbox-close").onclick(); loadGallery();
  } catch (error) { alert(`删除失败：${error.message}`); }
  finally { $("lightbox-delete").disabled = false; $("lightbox-delete").textContent = "删除"; }
}
$("lightbox-close").onclick = () => { $("lightbox-image").src = ""; $("lightbox").classList.add("hidden"); };
document.querySelector(".lightbox-backdrop").onclick = () => $("lightbox-close").onclick();
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("lightbox").classList.contains("hidden")) $("lightbox-close").onclick(); });

function switchTab(tab) {
  state.tab = tab;
  for (const node of document.querySelectorAll(".tab")) node.classList.toggle("active", node.dataset.tab === tab);
  $("page-home").classList.toggle("hidden", tab !== "home");
  $("page-gallery").classList.toggle("hidden", tab !== "gallery");
  history.replaceState(null, "", tab === "home" ? "/" : "/#gallery");
}
for (const node of document.querySelectorAll(".tab")) node.onclick = () => switchTab(node.dataset.tab);

async function upload(file) {
  setStatus(`正在处理 ${file.name}……`); $("upload-results").innerHTML = "";
  const form = new FormData(); form.append("file", file);
  try { const data = await api("/api/upload", { method: "POST", body: form }); $("upload-results").innerHTML = `<div class="result"><img src="${data.url}" alt=""><span class="url">${escapeHtml(data.url)}</span><button data-copy="${escapeHtml(data.markdown)}">复制 Markdown</button></div>`; $("upload-results").querySelectorAll("[data-copy]").forEach((button) => button.onclick = async () => copyText(button.dataset.copy, button)); setStatus("上传成功"); if (state.tab === "gallery") await loadGallery(); }
  catch (error) { setStatus(error.message, true); }
}

$("file-input").onchange = (event) => { if (event.target.files[0]) upload(event.target.files[0]); };
$("dropzone").ondragover = (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); };
$("dropzone").ondragleave = () => $("dropzone").classList.remove("dragging");
$("dropzone").ondrop = (event) => { event.preventDefault(); $("dropzone").classList.remove("dragging"); if (event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]); };
$("refresh").onclick = loadGallery; $("previous").onclick = () => { state.page -= 1; loadGallery(); }; $("next").onclick = () => { state.page += 1; loadGallery(); };

loadAccount();
switchTab(location.hash === "#gallery" ? "gallery" : "home");
if (location.hash === "#gallery") loadGallery();
