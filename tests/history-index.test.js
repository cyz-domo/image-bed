import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecords, serializeIndex, parseIndex, upsertRecords, dropRecords, recordsToItems, itemsToRecords } from "../cloud-functions/_lib/history-index.js";
import { imageUrl, imageBase } from "../cloud-functions/_lib/image-url.js";

const SHA = "793595df1a2867785755e628be39123e537f350e";
const env = { GITHUB_OWNER: "me", GITHUB_REPO: "image-bed" };

test("normalizeRecords drops bad rows, dedupes by path and sorts newest first", () => {
  const records = normalizeRecords([
    { p: "images/2026/08/a.webp", s: 10 },
    { p: "images/2026/09/b.webp", t: 1 },
    { p: "README.md" },
    { p: "images/2026/09/b.webp", s: 5 },
    { p: "images/2026/07/c.mp4", t: 0 },
    { p: "images/2026/07/d.webp", c: "not-a-sha" },
  ]);
  assert.deepEqual(records.map((record) => record.p), ["images/2026/09/b.webp", "images/2026/08/a.webp", "images/2026/07/d.webp", "images/2026/07/c.mp4"]);
  assert.deepEqual(records[0], { p: "images/2026/09/b.webp", s: 5 });
  assert.deepEqual(records[2], { p: "images/2026/07/d.webp" });
  assert.deepEqual(records[3], { p: "images/2026/07/c.mp4" });
});

test("serializeIndex and parseIndex round-trip, and reject records over the size limit", () => {
  const records = normalizeRecords([{ p: "images/壁纸/2026/09/x.webp", t: 1, s: 1234, c: SHA }]);
  assert.deepEqual(parseIndex(serializeIndex(records)), records);
  assert.equal(parseIndex("{not json"), null);
  assert.equal(parseIndex(JSON.stringify({ v: 2, items: [] })), null);
  const oversized = Array.from({ length: 12000 }, (unused, index) => ({ p: `images/2026/09/20260901000000-${index}-abcdefghijklmnop.webp`, t: 1, s: index, c: SHA }));
  assert.throws(() => serializeIndex(oversized), (error) => error.code === "INDEX_TOO_LARGE");
});

test("upsertRecords keeps image and thumbnail commits, defaulting the thumbnail to the image commit", () => {
  const records = upsertRecords([{ p: "images/2026/08/old.webp", t: 1, m: SHA }], [
    { path: "images/2026/09/new.webp", thumbPath: ".thumbnails/2026/09/new.webp", bytes: 2048, commit: SHA },
    { path: "images/2026/09/late.webp", thumbPath: ".thumbnails/2026/09/late.webp", commit: SHA, thumbCommit: "0".repeat(40) },
    { path: "secrets/2026/09/nope.webp", commit: SHA },
  ]);
  const byPath = new Map(records.map((record) => [record.p, record]));
  assert.deepEqual(byPath.get("images/2026/09/new.webp"), { p: "images/2026/09/new.webp", t: 1, s: 2048, c: SHA, m: SHA });
  assert.deepEqual(byPath.get("images/2026/09/late.webp"), { p: "images/2026/09/late.webp", t: 1, c: SHA, m: "0".repeat(40) });
  assert.equal(byPath.has("secrets/2026/09/nope.webp"), false);
  assert.deepEqual(byPath.get("images/2026/08/old.webp"), { p: "images/2026/08/old.webp", t: 1, m: SHA });
});

test("dropRecords removes deleted paths and itemsToRecords round-trips history items", () => {
  const items = [
    { path: "images/2026/09/a.webp", thumb: ".thumbnails/2026/09/a.webp", bytes: 9, commit: SHA },
    { path: "images/2026/09/b.mp4", bytes: 100 },
  ];
  const records = itemsToRecords(items);
  const kept = recordsToItems(dropRecords(records, ["images/2026/09/a.webp"]));
  assert.deepEqual(kept, [{ path: "images/2026/09/b.mp4", type: "video", bytes: 100 }]);
  assert.deepEqual(recordsToItems(records).find((item) => item.path === "images/2026/09/a.webp"), { path: "images/2026/09/a.webp", type: "image", thumb: ".thumbnails/2026/09/a.webp", bytes: 9, commit: SHA, thumbCommit: SHA });
  assert.deepEqual(records.map((record) => record.p), ["images/2026/09/b.mp4", "images/2026/09/a.webp"]);
});

test("imageUrl pins to a commit only for a full sha, otherwise falls back to the branch", () => {
  const settings = { accelerator_base_url: "https://cdn.example" };
  assert.equal(imageUrl(env, "images/2026/09/测试/a.webp", settings, SHA), `https://cdn.example/gh/me/image-bed@${SHA}/images/2026/09/%E6%B5%8B%E8%AF%95/a.webp`);
  assert.match(imageUrl(env, "images/2026/09/a.webp", settings, "deadbeef"), /@main\/images\/2026\/09\/a\.webp$/);
  assert.match(imageUrl(env, "images/2026/09/a.webp", settings, "main"), /@main\//);
  assert.match(imageUrl(env, "images/2026/09/a.webp", settings, "https://evil/@1"), /@main\//);
  assert.match(imageBase(env, {}), /cdn\.jsdelivr\.net\/gh\/me\/image-bed@main$/);
});

// 用 ?instance= 再导入一份模块，拿到独立的实例内缓存，不干扰上面的静态测试
const indexFile = async (instance) => import(`../cloud-functions/_lib/history-index.js?instance=${instance}`);
const indexBody = (records) => {
  const text = JSON.stringify({ v: 1, count: records.length, items: records });
  return { content: Buffer.from(text, "utf8").toString("base64"), sha: "a".repeat(40) };
};
function fakeGithub(records, calls) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    const method = String(init.method || "GET").toUpperCase();
    if (url.includes("/app/installations/")) return Response.json({ token: "fake-installation-token" });
    if (!url.includes("contents/.state/index.json")) return real(input, init);
    calls.push(method);
    if (method === "PUT") return Response.json({ commit: { sha: "b".repeat(40) } });
    return Response.json(indexBody(records));
  };
  return () => { globalThis.fetch = real; };
}

test("readIndex 在实例内只回源一次，写入后立刻作废缓存", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  process.env.GITHUB_APP_PRIVATE_KEY_B64 = Buffer.from(pem, "utf8").toString("base64");
  const records = [{ p: "images/2026/09/20260901000000-a.webp", t: 1, s: 10 }];
  const calls = [];
  const restore = fakeGithub(records, calls);
  try {
    const { readIndex, writeIndex } = await indexFile("memo");
    const first = await readIndex(env);
    const second = await readIndex(env);
    assert.deepEqual(calls, ["GET"], "第二次读索引应命中实例内缓存");
    assert.deepEqual(first.records, records);
    assert.equal(first.sha, second.sha);
    await writeIndex(env, [{ p: "images/2026/09/20260901000001-b.webp" }], "chore: test index write");
    assert.deepEqual(calls, ["GET", "PUT"], "写入应复用缓存里的 sha，不再多读一次");
    await readIndex(env);
    assert.deepEqual(calls, ["GET", "PUT", "GET"], "写入完成后缓存必须作废");
  } finally {
    restore();
    delete process.env.GITHUB_APP_PRIVATE_KEY_B64;
  }
});
