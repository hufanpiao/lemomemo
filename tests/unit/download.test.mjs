// 职责：下载适配器测试：platform/download.js 的 claude 版（接 tests/mock/claude-stub.js 的 downloads 桩）和测试页的 mock 版，
//       保存成功、用户拒绝、平台不可用时的错误码；拒绝后不重试。
// 依赖：tests/lib/harness.mjs、src/scripts/platform/index.js、platform/download.js、tests/mock/mock-download.js、tests/mock/claude-stub.js
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import assert from "node:assert/strict";
import { ROOT, loadApp, src, test, done } from "../lib/harness.mjs";

function claudeCtx(globals){
  const ctx = loadApp([src("platform/index.js"), src("platform/download.js")], Object.assign({ plannerStubSeed: { events: {}, todos: {} } }, globals));
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, "tests/mock/claude-stub.js"), "utf8"), ctx);
  return ctx;
}
const req = { filename: "planner-backup-2026-10-23.json", data: '{"a":1}' };

test("claude 版：保存成功返回 saved，文件名和内容原样交给平台", async () => {
  const ctx = claudeCtx({});
  ctx.App.platform.download.use("claude");
  assert.equal((await ctx.App.platform.download.save(req)).status, "saved");
  assert.equal(ctx.plannerLastDownload.filename, req.filename);
  assert.equal(ctx.plannerLastDownload.data, req.data);
});
test("claude 版：用户拒绝 → declined，没有再试", async () => {
  const ctx = claudeCtx({ plannerStubDownloadFail: "declined" });
  ctx.App.platform.download.use("claude");
  await assert.rejects(() => ctx.App.platform.download.save(req), e => e.code === "declined");
  assert.equal(ctx.plannerDownloads, undefined);
});
test("claude 版：平台错误码统一（not_granted → unavailable，rejected_extension → format，未知 → failed）", async () => {
  for (const [from, to] of [["not_granted", "unavailable"], ["rejected_extension", "format"], ["rate_limited", "rate_limited"], ["weird", "failed"]]) {
    const ctx = claudeCtx({ plannerStubDownloadFail: from });
    ctx.App.platform.download.use("claude");
    await assert.rejects(() => ctx.App.platform.download.save(req), e => e.code === to, from);
  }
});
test("claude 版：use(\"downloads\") 返回 null 或没有 window.claude 时 → unavailable", async () => {
  const ctx = claudeCtx({ plannerStubNoDownloads: true });
  ctx.App.platform.download.use("claude");
  await assert.rejects(() => ctx.App.platform.download.save(req), e => e.code === "unavailable");
  const bare = loadApp([src("platform/index.js"), src("platform/download.js")]);
  bare.window = bare;
  bare.App.platform.download.use("claude");
  await assert.rejects(() => bare.App.platform.download.save(req), e => e.code === "unavailable");
});
test("mock 版：记下文件；可模拟拒绝", async () => {
  const ctx = loadApp([src("platform/index.js"), src("platform/download.js"), "tests/mock/mock-download.js"]);
  ctx.App.platform.download.use("mock");
  assert.equal((await ctx.App.platform.download.save(req)).status, "saved");
  assert.equal(ctx.plannerLastDownload.filename, req.filename);
  ctx.plannerDownloadFail = "declined";
  await assert.rejects(() => ctx.App.platform.download.save(req), e => e.code === "declined");
});

await done("下载适配器测试（claude / mock）");
