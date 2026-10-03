#!/usr/bin/env node
// 一次性补齐存量图片的缩略图，并生成/刷新图库索引 .state/index.json。
// 存量老图（缩略图功能上线前上传的）在图库里会直接加载几 MB 的原图，这个脚本给它们补 320px webp，
// 同时把每张图"最后一次改动的 commit"写进索引，让图片地址能钉到 commit 拿到 CDN 长缓存。
//
// 用法（在一个已 clone 的图片仓库目录里跑，默认当前目录）：
//   node scripts/backfill-thumbnails.mjs                  # 只报告，不写任何东西
//   node scripts/backfill-thumbnails.mjs --apply          # 真正生成缩略图并提交（需要 gh 已登录 + 本地装了 sharp）
//   node scripts/backfill-thumbnails.mjs --apply --index-only   # 只重写索引，不补缩略图（不需要 sharp）
//   node scripts/backfill-thumbnails.mjs --out=index.preview.json   # 把索引写到本地文件，便于核对
//   可选：--repo-dir=.. --owner=.. --repo=.. --limit=3 --branch=main
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const found = args.find((item) => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const APPLY = flag("apply");
const INDEX_ONLY = flag("index-only");
const repoDir = path.resolve(option("repo-dir", "."));
const branch = option("branch", "main");
const limit = Number(option("limit", "0")) || Infinity;
const THUMB_WIDTH = 320;

const gh = (apiPath, options = {}) => {
  const command = ["api", options.method ? `--method=${options.method}` : null, apiPath, ...(options.fields || [])].filter(Boolean);
  if (options.body !== undefined) { command.push("--input=-"); }
  const output = execFileSync("gh", command, { cwd: repoDir, encoding: "utf8", maxBuffer: 512 * 1048576, input: options.body !== undefined ? options.body : undefined, stdio: undefined });
  const text = String(output || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
};

const fail = (message) => { console.error(`✖ ${message}`); process.exit(1); };

// 仓库归属默认读环境变量文件，缺省用 cyz-domo/image-bed
const envFile = existsSync(path.join(repoDir, ".env")) ? readFileSync(path.join(repoDir, ".env"), "utf8") : "";
const envValue = (name, fallback) => (envFile.match(new RegExp(`^${name}=(.*)$`, "m")) || [])[1]?.trim() || process.env[name] || fallback;
const owner = option("owner", envValue("GITHUB_OWNER", "cyz-domo"));
const repo = option("repo", envValue("GITHUB_REPO", "image-bed"));

const MEDIA_PATH = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/.+\.(?:png|jpe?g|gif|webp|mp4)$/i;
const STILL_PATH = /^images\/(?:[^/]+\/)?\d{4}\/\d{2}\/.+\.(?:png|jpe?g|gif|webp)$/i;
const thumbPathOf = (imagePath) => `.thumbnails/${imagePath.slice("images/".length)}`;
const base64 = (bytes) => Buffer.from(bytes).toString("base64");
const git = (args, options = {}) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", maxBuffer: 512 * 1048576, ...options }).trim?.() ?? "";
// 本地可能只 fetch 了当前分支，图片分支要以 origin/<branch> 的形式引用
const quiet = { stdio: ["ignore", "pipe", "ignore"] };
let ref = branch;
try { git(["rev-parse", "--verify", `${branch}^{commit}`], quiet); }
catch {
  try { git(["rev-parse", "--verify", `origin/${branch}^{commit}`], quiet); ref = `origin/${branch}`; }
  catch { fail(`本地仓库没有 ${branch} 分支，先在 ${repoDir} 执行 git fetch origin ${branch}`); }
}
console.log(`本地引用：${ref}`);

console.log(`仓库 ${owner}/${repo} 分支 ${branch}（目录 ${repoDir}），模式：${APPLY ? "写入" : "仅报告"}`);

// 1. 取当前分支的完整 tree
const tree = gh(`repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
if (!tree) fail("无法读取仓库 tree");
if (tree.truncated) fail("GitHub tree 结果被截断，请先手工整理仓库文件");
const blobs = (tree.tree || []).filter((entry) => entry.type === "blob");
const media = blobs.filter((entry) => MEDIA_PATH.test(entry.path));
const stills = media.filter((entry) => STILL_PATH.test(entry.path));
const thumbSet = new Set(blobs.filter((entry) => entry.path.startsWith(".thumbnails/")).map((entry) => entry.path));
const missing = stills.filter((entry) => !thumbSet.has(thumbPathOf(entry.path)));
console.log(`图库文件 ${media.length} 个（图片 ${stills.length} / 视频 ${media.length - stills.length}），已有缩略图 ${stills.length - missing.length} 张，待补 ${missing.length} 张`);
for (const entry of missing.slice(0, 20)) console.log(`  缺缩略图：${entry.path}（${(entry.size / 1048576).toFixed(1)} MB）`);

// 2. 生成缺失的缩略图（sharp 本地跑，避免占用边缘函数的执行时限）
const generated = [];
if (!INDEX_ONLY && missing.length) {
  if (!APPLY) console.log("（仅报告模式：加 --apply 才会真正生成并提交缩略图）");
  else {
    let sharp;
    try { sharp = (await import("sharp")).default; } catch { fail("未安装 sharp，先在仓库目录执行 npm install"); }
    const head = gh(`repos/${owner}/${repo}/git/ref/heads/${branch}`).object.sha;
    const baseTree = gh(`repos/${owner}/${repo}/git/commits/${head}`).tree.sha;
    const entries = [];
    for (const entry of missing.slice(0, limit)) {
      // 原图字节直接从本地 git 对象读，绕开 CDN 抖动
      let raw;
      try { raw = execFileSync("git", ["cat-file", "blob", `${ref}:${entry.path}`], { cwd: repoDir, maxBuffer: 64 * 1048576, encoding: "buffer" }); }
      catch { fail(`本地 git 读不到 ${entry.path}，请先在 ${repoDir} 执行 git fetch origin ${branch}`); }
      const webp = await sharp(raw).resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: "inside", withoutEnlargement: true }).webp({ quality: 65, effort: 4 }).toBuffer();
      const thumbPath = thumbPathOf(entry.path);
      const blob = gh(`repos/${owner}/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: base64(webp), encoding: "base64" }) });
      entries.push({ path: thumbPath, mode: "100644", type: "blob", sha: blob.sha });
      generated.push({ path: thumbPath, bytes: webp.length });
      console.log(`  已生成 ${thumbPath}（${(webp.length / 1024).toFixed(0)} KB，原 ${(entry.size / 1048576).toFixed(1)} MB）`);
    }
    const newTree = gh(`repos/${owner}/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree: entries }) }).sha;
    const commit = gh(`repos/${owner}/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message: `chore: backfill ${entries.length} thumbnails`, tree: newTree, parents: [head] }) }).sha;
    gh(`repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit, force: false }) });
    console.log(`缩略图提交完成：${commit}（${entries.length} 个文件）`);
    generated.forEach((item) => { item.commit = commit; });
  }
}

// 3. 建索引：c=最后一次改动该图片的 commit，m=最后一次改动其缩略图的 commit，s=原图字节
const commitOfPath = (filePath) => { try { return git(["log", "-1", "--format=%H", ref, "--", filePath]) || undefined; } catch { return undefined; } };
const generatedCommit = new Map(generated.map((item) => [item.path, item.commit]));
const records = media.map((entry) => {
  const thumbPath = thumbPathOf(entry.path);
  const hasThumb = thumbSet.has(thumbPath) || generatedCommit.has(thumbPath);
  const record = { p: entry.path };
  if (hasThumb) record.t = 1;
  if (Number.isSafeInteger(entry.size)) record.s = entry.size;
  const imageCommit = commitOfPath(entry.path);
  if (/^[0-9a-f]{40}$/.test(imageCommit || "")) record.c = imageCommit;
  const thumbCommit = generatedCommit.get(thumbPath) || commitOfPath(thumbPath);
  if (hasThumb && /^[0-9a-f]{40}$/.test(thumbCommit || "")) record.m = thumbCommit;
  return record;
}).sort((a, b) => (a.p < b.p ? 1 : a.p > b.p ? -1 : 0));
const pinned = records.filter((record) => record.c).length;
console.log(`索引条目 ${records.length} 条，其中 ${pinned} 条可钉 commit（缩略图可钉 ${records.filter((record) => record.m).length} 条）`);

// 4. 写索引文件（一次 contents PUT，GitHub 自动提交）
const indexText = JSON.stringify({ v: 1, count: records.length, items: records });
console.log(`索引大小 ${(indexText.length / 1024).toFixed(1)} KB`);
const outFile = option("out", "");
if (outFile) { writeFileSync(path.resolve(repoDir, outFile), indexText, "utf8"); console.log(`✔ 索引已写到本地 ${outFile}`); }
if (APPLY) {
  const existing = gh(`repos/${owner}/${repo}/contents/.state/index.json?ref=${branch}`);
  gh(`repos/${owner}/${repo}/contents/.state/index.json`, {
    method: "PUT",
    body: JSON.stringify({ message: "chore: rebuild image index", content: base64(Buffer.from(indexText, "utf8")), branch, ...(existing?.sha ? { sha: existing.sha } : {}) }),
  });
  console.log("✔ 已写入 .state/index.json");
} else {
  console.log("（仅报告模式：索引未写入。示例前三条：）");
  console.log(JSON.stringify(records.slice(0, 3), null, 2));
}
if (!APPLY) console.log("\n以上为dry-run 结果，确认无误后加 --apply 执行。");
