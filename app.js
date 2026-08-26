const state = { page: 1, hasNext: false };
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

async function loadAccount() {
  const account = $("account");
  try {
    const data = await api("/api/auth/me");
    if (data.authenticated) {
      account.innerHTML = `<span>@${data.login}</span><button id="logout">退出</button>`;
      $("upload-panel").classList.remove("hidden");
      $("logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); };
    } else account.innerHTML = '<a class="login" href="/api/auth/login">使用 GitHub 登录上传</a>';
  } catch { account.innerHTML = '<a class="login" href="/api/auth/login">使用 GitHub 登录上传</a>'; }
}

function renderHistory(items) {
  const root = $("history");
  root.innerHTML = items.length ? items.map((item) => `<div class="history-row"><img loading="lazy" src="${item.url}" alt=""><span class="url" title="${item.url}">${item.path}</span><button data-copy="${item.url}">复制链接</button></div>`).join("") : '<p class="subtle">暂无上传记录。</p>';
  root.querySelectorAll("[data-copy]").forEach((button) => button.onclick = async () => { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = "已复制"; });
}

async function loadHistory() {
  $("history").innerHTML = '<p class="subtle">正在加载……</p>';
  try { const data = await api(`/api/history?page=${state.page}`); renderHistory(data.items); state.hasNext = data.has_next; $("previous").disabled = state.page === 1; $("next").disabled = !state.hasNext; $("page-label").textContent = `第 ${state.page} 页`; }
  catch (error) { $("history").innerHTML = `<p class="status error">${error.message}</p>`; }
}

async function upload(file) {
  setStatus(`正在处理 ${file.name}……`); $("upload-results").innerHTML = "";
  const form = new FormData(); form.append("file", file);
  try { const data = await api("/api/upload", { method: "POST", body: form }); $("upload-results").innerHTML = `<div class="result"><img src="${data.url}" alt=""><span class="url">${data.url}</span><button data-copy="${data.markdown}">复制 Markdown</button></div>`; $("upload-results").querySelector("button").onclick = async (event) => { await navigator.clipboard.writeText(event.currentTarget.dataset.copy); event.currentTarget.textContent = "已复制"; }; setStatus("上传成功"); state.page = 1; await loadHistory(); }
  catch (error) { setStatus(error.message, true); }
}

$("file-input").onchange = (event) => { if (event.target.files[0]) upload(event.target.files[0]); };
$("dropzone").ondragover = (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); };
$("dropzone").ondragleave = () => $("dropzone").classList.remove("dragging");
$("dropzone").ondrop = (event) => { event.preventDefault(); $("dropzone").classList.remove("dragging"); if (event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]); };
$("refresh").onclick = loadHistory; $("previous").onclick = () => { state.page -= 1; loadHistory(); }; $("next").onclick = () => { state.page += 1; loadHistory(); };
loadAccount(); loadHistory();

