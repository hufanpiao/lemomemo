// 职责：存储适配器契约测试：同一套用例同时跑 mock-db 和 claude-db（后者接 tests/mock/claude-stub.js 模拟的 window.claude），
//       保证两者行为一致：连接、首次全量快照、id 以文档 id 为准、newId 同步且不重复、add / update / remove、
//       写入失败时给中性错误码。以后加 REST 适配器时，在 ADAPTERS 里加一项就能复用全部用例。
// 依赖：tests/lib/harness.mjs、src/scripts/platform/index.js、platform/claude-db.js、tests/mock/mock-db.js、tests/mock/claude-stub.js
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { ROOT, loadApp, src, plain, sleep, test, done } from "../lib/harness.mjs";

const SEED = () => ({
  events: { e1: { title: "对片", date: "2026-10-23", time: "10:00" } },
  todos: { t1: { title: "交成片", done: false }, t2: { title: "数据里自带 id", id: "evil" } },
});

// 每个适配器：make(seed, failCode) → {adapter}
const ADAPTERS = {
  "mock-db": (seed, failCode) => {
    const ctx = loadApp([src("platform/index.js"), "tests/mock/mock-db.js"]);
    return ctx.App.platform.storage["mock-db"]({ seed, delay: 0, fail: () => failCode || null });
  },
  "claude-db": (seed, failCode) => {
    const ctx = loadApp([src("platform/index.js"), src("platform/claude-db.js")], {
      plannerStubSeed: seed, plannerStubDelay: 0, plannerStubFail: failCode || null,
    });
    ctx.window = ctx;
    loadInto(ctx, "tests/mock/claude-stub.js");
    return ctx.App.platform.storage["claude-db"]();
  },
};
function loadInto(ctx, f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f }); }

// 订阅并等第一份快照
async function firstSnap(a, coll) {
  let snap = null;
  a.subscribe(coll, s => { snap = s; }, () => {});
  for (let i = 0; i < 50 && !snap; i++) await sleep(2);
  return snap;
}
async function latest(a, coll) { await sleep(10); return firstSnap(a, coll); }

for (const [name, make] of Object.entries(ADAPTERS)) {
  test(`${name}：connect 返回 true`, async () => assert.equal(await make(SEED()).connect(), true));
  test(`${name}：首次订阅收到全量快照，changes() 是数组`, async () => {
    const a = make(SEED()); await a.connect();
    const s = await firstSnap(a, "todos");
    assert.deepEqual(plain(s.items.map(x => x.id)).sort(), ["t1", "t2"]);
    assert.ok(Array.isArray(plain(s.changes())));
  });
  test(`${name}：记录 id 以文档 id 为准，数据里的 id 不能覆盖`, async () => {
    const a = make(SEED()); await a.connect();
    const s = await firstSnap(a, "todos");
    assert.equal(s.items.find(x => x.title === "数据里自带 id").id, "t2");
  });
  test(`${name}：get 读一条，不存在返回 null（v3）`, async () => {
    const a = make(SEED()); await a.connect();
    const t = plain(await a.get("todos", "t2"));
    assert.equal(t.id, "t2"); assert.equal(t.title, "数据里自带 id");
    assert.equal(await a.get("todos", "没有这条"), null);
  });
  test(`${name}：新集合 logs 可以写入、读出、列出（v3）`, async () => {
    const a = make(SEED()); await a.connect();
    await a.add("logs", "2026-10-23_dev1", { day: "2026-10-23", device: "dev1", entries: [{ t: 1, kind: "op", act: "create", src: "page" }] });
    assert.equal(plain(await a.get("logs", "2026-10-23_dev1")).entries.length, 1);
    assert.deepEqual(plain((await a.list("logs")).map(x => x.id)), ["2026-10-23_dev1"]);
  });
  test(`${name}：newId 同步返回且不重复`, async () => {
    const a = make(SEED()); await a.connect();
    const x = a.newId("todos"), y = a.newId("todos");
    assert.equal(typeof x, "string"); assert.notEqual(x, y);
  });
  test(`${name}：add → update → remove 都反映在快照里`, async () => {
    const a = make(SEED()); await a.connect();
    const id = a.newId("todos");
    await a.add("todos", id, { title: "新的", done: false });
    let s = await latest(a, "todos");
    assert.equal(s.items.find(x => x.id === id).title, "新的");
    await a.update("todos", id, { done: true, deletedAt: 123 });
    s = await latest(a, "todos");
    const it = s.items.find(x => x.id === id);
    assert.equal(it.done, true); assert.equal(it.title, "新的"); assert.equal(it.deletedAt, 123);
    await a.update("todos", id, { deletedAt: null });
    s = await latest(a, "todos");
    assert.equal(s.items.find(x => x.id === id).deletedAt, null);
    await a.remove("todos", id);
    s = await latest(a, "todos");
    assert.equal(s.items.some(x => x.id === id), false);
  });
  test(`${name}：写入失败时给中性错误码`, async () => {
    const a = make(SEED(), name === "claude-db" ? "invalid_argument" : "forbidden"); await a.connect();
    await assert.rejects(() => a.update("todos", "t1", { done: true }), e => e.code === "forbidden");
  });
  test(`${name}：未知平台错误映射成 network`, async () => {
    const a = make(SEED(), name === "claude-db" ? "something_else" : "network"); await a.connect();
    await assert.rejects(() => a.add("todos", a.newId("todos"), {}), e => e.code === "network");
  });
}
test("claude-db：没有 window.claude 时 connect 返回 false，并给出提示文案", async () => {
  const ctx = loadApp([src("platform/index.js"), src("platform/claude-db.js")]);
  ctx.window = ctx;
  const a = ctx.App.platform.storage["claude-db"]();
  assert.equal(await a.connect(), false);
  assert.match(a.unavailableHint().text, /claude\.ai/);
});

await done("存储适配器契约测试（mock-db / claude-db）");
