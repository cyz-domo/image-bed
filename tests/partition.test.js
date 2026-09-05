import test from "node:test";
import assert from "node:assert/strict";
import { validPartition, partitionOf } from "../cloud-functions/_lib/partition.js";

test("validPartition accepts names and rejects invalid ones", () => {
  assert.equal(validPartition("wallpaper"), true);
  assert.equal(validPartition("壁纸"), true);
  assert.equal(validPartition("my-part_2"), true);
  assert.equal(validPartition(""), false);
  assert.equal(validPartition("2026"), false);
  assert.equal(validPartition("a".repeat(33)), false);
  assert.equal(validPartition("bad/name"), false);
  assert.equal(validPartition("空格 名"), false);
});

test("partitionOf derives partition from image paths", () => {
  assert.equal(partitionOf("images/2026/09/abc.webp"), "");
  assert.equal(partitionOf("images/wallpaper/2026/09/abc.webp"), "wallpaper");
  assert.equal(partitionOf("images/壁纸/2026/12/abc.webp"), "壁纸");
  assert.equal(partitionOf(".thumbnails/2026/09/abc.webp"), "");
  assert.equal(partitionOf(""), "");
});
