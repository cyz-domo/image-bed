#!/usr/bin/env node
// 给站点盖构建版本戳：把当前 HEAD 的 commit 信息与“上线文件内容指纹”写进 version.json（前端读）
// 和 cloud-functions/_lib/version.js（/api/health 读）。
// EdgeOne Pages 对纯静态项目不注入构建元数据，所以版本只能随提交写入；指纹不含版本文件本身，
// 因此同一份代码无论提交几次都得到同一个值，deploy-check 可以逐字节比对线上与本地。
//
// 用法：node scripts/gen-version.mjs         # 写文件（内容没变则不动）
//       node scripts/gen-version.mjs --print # 只把 JSON 打到 stdout，供脚本比对
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRINT = process.argv.includes("--print");
const VERSION_JSON = path.join(root, "version.json");
const VERSION_LIB = path.join(root, "cloud-functions/_lib/version.js");

// 只统计真正会随站点发出的文件；版本产物自己必须排除，否则指纹会自指
const shippedFiles = () => {
  const files = ["index.html", "app.js", "styles.css"];
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full === VERSION_LIB ? [] : [full];
  });
  return files.map((file) => path.join(root, file)).concat(walk(path.join(root, "cloud-functions"))).sort();
};

const hash = createHash("sha256");
for (const file of shippedFiles()) hash.update(`${path.relative(root, file).replaceAll("\\", "/")}\n`).update(readFileSync(file)).update("\n");
const fingerprint = hash.copy().digest("hex").slice(0, 12);

const git = (args) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return ""; } };
const [short, sha, time, message] = git(["log", "-1", "--format=%h%x00%H%x00%cI%x00%s"]).split("\0");
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

const build = { fingerprint, branch: branch || "unknown", sha: sha || "unknown", short: short || "unknown", time: time || "unknown", message: message || "" };
const json = `${JSON.stringify(build, null, 2)}\n`;

if (PRINT) { process.stdout.write(json); process.exit(0); }

const lib = `// 由 scripts/gen-version.mjs 生成，请勿手改：/api/health 用它回答“线上跑的是哪一版”。\nexport const BUILD = ${json.trim()};\n`;
const differs = (file, text) => { try { return readFileSync(file, "utf8") !== text; } catch { return true; } };

if (differs(VERSION_JSON, json) || differs(VERSION_LIB, lib)) {
  writeFileSync(VERSION_JSON, json, "utf8");
  writeFileSync(VERSION_LIB, lib, "utf8");
  console.log(`✔ 版本已盖戳：${build.short} · ${build.time} · 指纹 ${build.fingerprint}`);
} else {
  console.log(`版本文件已是最新（${build.short} · 指纹 ${build.fingerprint}），未改动`);
}
