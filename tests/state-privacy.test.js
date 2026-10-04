import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

// 状态文件写在公开仓库里：任何"谁传了哪张图"的明文都不该落盘，
// 名单也改由环境变量提供。这里用假 GitHub 状态文件验脱敏与判定仍然对得上。
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const today = new Date().toISOString().slice(0, 10);
const SECRET = "privacy-test-secret";
const PLAIN_STATE = {
  revoked: ["sid-1"],
  daily: { key: "2020-01-01", count: 999, alice: { key: today, count: 3 }, bob: { key: "2020-01-01", count: 5 } },
  settings: { daily_upload_limit: 50, allowed_users: ["friend", "other@example.com"] },
  links: {},
  owners: { "images/2026/10/a.webp": "alice", "images/2026/10/b.webp": "Alice ", "images/2026/10/c.webp": "" },
};

function stubState(state) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/app/installations/")) return Response.json({ token: "t" });
    if (url.includes("contents/.state/state.json")) return Response.json({ sha: "state-sha", content: b64(JSON.stringify(state)) });
    return real(input, init);
  };
  return () => { globalThis.fetch = real; };
}

const envFor = (extra = {}) => ({
  GITHUB_OWNER: "cyz-domo", GITHUB_REPO: "image-bed",
  GITHUB_APP_ID: "0", GITHUB_APP_INSTALLATION_ID: "0", GITHUB_APP_PRIVATE_KEY_B64: b64(PEM),
  SESSION_SECRET: SECRET, ALLOWED_GITHUB_LOGIN: "alice", ...extra,
});
// 每个用例独立加载模块，避开实例内 15 秒状态记忆互相污染
const freshModule = async (tag) => import(`../cloud-functions/_lib/state.js?case=${tag}`);
const auth = await import("../cloud-functions/_lib/auth.js");

test("userId 只留不可逆 id，同一 login 永远算出同一个", async () => {
  const id = await (await freshModule("id")).userId(envFor(), "Alice ");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(await (await freshModule("id2")).userId(envFor(), "alice"), id, "大小写与空格不影响 id");
  assert.equal(await (await freshModule("id3")).userId(envFor(), id), id, "id 再换算一次还是自己");
  const mod4 = await freshModule("id4");
  await assert.rejects(() => mod4.userId({}, "alice"), /SESSION_SECRET/);
});

test("sanitizeState 折 id、清过期计数，并在环境变量接管后删掉仓库名单", async () => {
  const restore = stubState(PLAIN_STATE);
  const mod = await freshModule("sanitize");
  const withoutEnv = await mod.sanitizeState(structuredClone(PLAIN_STATE), envFor());
  const idOfAlice = await mod.userId(envFor(), "alice");

  assert.deepEqual(withoutEnv.owners, { "images/2026/10/a.webp": idOfAlice, "images/2026/10/b.webp": idOfAlice }, "空归属丢弃，明文换成 id");
  assert.deepEqual(withoutEnv.daily, { [idOfAlice]: { key: today, count: 3 } }, "只留今天的计数，legacy key/count 与昨日记录清掉");
  assert.deepEqual(withoutEnv.settings.allowed_users, ["friend", "other@example.com"], "环境变量没配时名单原样保留，不会把人锁在门外");
  assert.deepEqual(withoutEnv.revoked, ["sid-1"], "其他字段原样保留");

  const withEnv = await mod.sanitizeState(structuredClone(PLAIN_STATE), envFor({ ALLOWED_USERS: "friend, other@example.com" }));
  assert.equal(withEnv.settings.allowed_users, undefined, "ALLOWED_USERS 已配置时仓库里的旧名单不再保留");
  restore();
});

test("允许名单：配置了 ALLOWED_USERS 就以环境变量为准，否则回退设置", async () => {
  const restore = stubState(PLAIN_STATE);
  const mod = await freshModule("allowlist");
  const legacy = await mod.sanitizeState(structuredClone(PLAIN_STATE), envFor());
  assert.deepEqual([...auth.allowedLogins(legacy, envFor())].sort(), ["alice", "friend", "other@example.com"], "环境变量缺失时用状态里的名单，管理员始终在内");
  assert.equal(auth.allowlistManagedByEnv(envFor()), false);

  const managed = await mod.sanitizeState(structuredClone(PLAIN_STATE), envFor({ ALLOWED_USERS: "zed, other@example.com" }));
  assert.deepEqual([...auth.allowedLogins(managed, envFor({ ALLOWED_USERS: "zed, other@example.com" }))].sort(), ["alice", "other@example.com", "zed"]);
  assert.equal(auth.allowlistManagedByEnv(envFor({ ALLOWED_USERS: "zed" })), true);
  restore();
});

test("loadState 读到的就是脱敏后的状态，ownerMatches 同时认得 id 与历史明文", async () => {
  const restore = stubState(PLAIN_STATE);
  const mod = await freshModule("load");
  const env = envFor({ ALLOWED_USERS: "friend" });
  const state = await mod.loadState(env);
  const idOfAlice = await mod.userId(env, "alice");
  assert.deepEqual(Object.values(state.owners), [idOfAlice, idOfAlice]);
  assert.equal(await mod.readDailyUsed(env, "alice"), 3, "按 login 查额度仍能命中脱敏后的计数");
  assert.equal(await mod.readDailyUsed(env, "bob"), 0, "昨天的计数已清除");

  assert.equal(mod.ownerMatches(idOfAlice, idOfAlice, "alice"), true);
  assert.equal(mod.ownerMatches("alice", idOfAlice, "alice"), true, "尚未脱敏的历史值也认");
  assert.equal(mod.ownerMatches("bob", idOfAlice, "alice"), false);
  assert.equal(mod.ownerMatches("", idOfAlice, "alice"), false, "无归属文件不算自己人");
  restore();
});
