import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

// 首屏合并后 /api/auth/me 一条响应要同时给出登录态、设置与额度，这里用假 GitHub 状态文件验形状
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const today = new Date().toISOString().slice(0, 10);
const STATE = { revoked: [], daily: { tester: { key: today, count: 7 } }, settings: { daily_upload_limit: 50, max_file_mb: 8, allowed_users: ["friend"], accelerator_base_url: "https://cdn.example" }, links: {}, owners: {} };

const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = String(init.method || input?.method || "GET").toUpperCase();
  calls.push(`${method} ${url.replace("https://api.github.com/repos/cyz-domo/image-bed/", "")}`);
  if (url.includes("/app/installations/")) return Response.json({ token: "installation-token" });
  if (url.includes("contents/.state/state.json")) return Response.json({ sha: "state-sha", content: b64(JSON.stringify(STATE)) });
  throw new Error(`测试桩拒绝的请求 ${method} ${url}`);
};

const env = {
  GITHUB_OWNER: "cyz-domo", GITHUB_REPO: "image-bed",
  GITHUB_APP_ID: "0", GITHUB_APP_INSTALLATION_ID: "0", GITHUB_APP_PRIVATE_KEY_B64: b64(PEM),
  SESSION_SECRET: "boot-test-secret", ALLOWED_GITHUB_LOGIN: "tester", MAX_FILE_SIZE: "10485760",
};

const { onRequest } = await import("../cloud-functions/api/auth/me.js");
const { sessionValue } = await import("../cloud-functions/_lib/auth.js");
const cookieFor = async (login) => ({ cookie: `image_session=${await sessionValue(login, env)}` });
const me = async (headers) => (await onRequest({ request: new Request("https://images.test/api/auth/me", { headers }), env })).json();

test("匿名访客也拿到设置，但看不到用户名单，也没有额度", async () => {
  const body = await me({});
  assert.equal(body.authenticated, false);
  assert.equal(body.is_admin, false);
  assert.equal(body.quota, undefined);
  assert.equal(body.settings.accelerator_base_url, "https://cdn.example");
  assert.equal("allowed_users" in body.settings, false);
  assert.deepEqual(body.defaults, { daily_upload_limit: 100, max_file_mb: 10 });
});

test("管理员登录后一次拿到设置与额度", async () => {
  const body = await me(await cookieFor("tester"));
  assert.equal(body.authenticated, true);
  assert.equal(body.is_admin, true);
  assert.deepEqual(body.settings.allowed_users, ["friend"]);
  assert.deepEqual(body.quota, { key: today, limit: 50, used: 7, remaining: 43 });
});

test("普通用户保留额度但看不到名单", async () => {
  const body = await me(await cookieFor("friend"));
  assert.equal(body.authenticated, true);
  assert.equal(body.is_admin, false);
  assert.equal("allowed_users" in body.settings, false);
  assert.deepEqual(body.quota, { key: today, limit: 50, used: 0, remaining: 50 });
  // 三次请求共用同一份状态：实例内 15 秒记忆生效，没有重复回源
  assert.deepEqual(calls.filter((call) => call.startsWith("GET")), ["GET contents/.state/state.json?ref=main"]);
});
