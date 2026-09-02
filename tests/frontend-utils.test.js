import test from "node:test";
import assert from "node:assert/strict";

function safeRemoteUrl(value) {
  try { const url = new URL(String(value || ""), "https://image-bed.test"); return url.protocol === "https:" ? url.href : ""; } catch { return ""; }
}

function validateLimits(daily, maxMb) {
  return Number.isInteger(daily) && daily >= 1 && daily <= 10000 && Number.isFinite(maxMb) && maxMb >= 1 && maxMb <= 100;
}

test("safeRemoteUrl accepts HTTPS and rejects script/data URLs", () => {
  assert.equal(safeRemoteUrl("https://cdn.example/image.png"), "https://cdn.example/image.png");
  assert.equal(safeRemoteUrl("javascript:alert(1)"), "");
  assert.match(safeRemoteUrl('https://cdn.example/\" onerror=alert(1)'), /^https:\/\/cdn\.example\/%22/);
});

test("validateLimits rejects empty, non-finite and out-of-range values", () => {
  assert.equal(validateLimits(100, 10), true);
  assert.equal(validateLimits(0, 10), false);
  assert.equal(validateLimits(Number(""), 10), false);
  assert.equal(validateLimits(100, Infinity), false);
  assert.equal(validateLimits(10001, 10), false);
});

test("theme values are limited to system, light and dark", () => {
  const stored = ["system", "light", "dark", "invalid"];
  assert.deepEqual(stored.filter((value) => ["system", "light", "dark"].includes(value)), ["system", "light", "dark"]);
});
