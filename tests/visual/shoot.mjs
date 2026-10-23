// 职责：成品截图工具。用无界面 Edge（Chrome DevTools 协议）打开本地测试页，按预设场景操作页面（新建日程触发提醒、
//       打开弹出层、切换页面等），在指定宽度和浅色 / 深色下截整页图，保存到 docs/02-设计/成品截图-v3/。
//       供 UI 复查和 QA 留档复用。前提：planner-test 预览服务在 8770 端口运行。
// 用法：node tests/visual/shoot.mjs [输出目录]
// 依赖：Node 22+（内置 fetch、WebSocket）、本机 Microsoft Edge
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "docs/02-设计/成品截图-v3");
const URL = "http://localhost:8770/dist/test.html";
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(p => fs.existsSync(p));
const PORT = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 场景：每个场景在页面里执行一段准备脚本，然后截图。$ 和 wait、add 由 PREP 提供
const PREP = `
  window.$ = id => document.getElementById(id);
  window.wait = ms => new Promise(r => setTimeout(r, ms));
  window.add = async (min, title) => {
    const d = new Date(Date.now() + min * 60000);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    $("plus").click(); await wait(400);
    $("q").value = "今天 " + hm + " " + title; $("q").dispatchEvent(new Event("input")); await wait(350);
    $("q-add").click(); await wait(900);
  };
  window.clearToasts = () => document.querySelectorAll("#toasts .toast").forEach(t => t.remove());
`;
const SCENES = [
  ["00-今天-下一件事提醒状态", `?empty`, `await add(4, "SignPlex 客户反馈会"); await add(9, "交 NEOX 竖版"); clearToasts(); scrollTo(0,0);`],
  ["00b-新建-锁定字段", `?empty`, `$("plus").click(); await wait(400); $("q").value = "明天下午3点 NEOX 对片"; $("q").dispatchEvent(new Event("input")); await wait(400); $("f-time").value = "16:00"; $("f-time").dispatchEvent(new Event("change")); $("details").hidden = true; await wait(300);`],

  ["01-今天-两种提醒", ``, `await add(4, "SignPlex 客户反馈会"); await add(9, "交 NEOX 竖版"); clearToasts(); scrollTo(0,0);`],
  ["02-主题选择器", ``, `document.querySelector(".theme-btn, #theme-btn, [aria-haspopup]").click(); await wait(400);`],
  ["03-新建-韩文识别", ``, `$("plus").click(); await wait(400); $("q").value = "내일 오후 3시 NEOX 미팅 30분 전 알림"; $("q").dispatchEvent(new Event("input")); await wait(500);`],
  ["04-编辑-细节展开", ``, `document.querySelector("[data-go=sched]").click(); await wait(300); document.querySelector("#v-sched .ev").click(); await wait(500);`],
  ["05-日程页", ``, `document.querySelector("[data-go=sched]").click(); await wait(400); scrollTo(0,0);`],
  ["05b-日程页-翻到下周", ``, `document.querySelector("[data-go=sched]").click(); await wait(300); $("wk-next").click(); await wait(400); scrollTo(0,0);`],
  ["06-待办页-最近删除展开", ``, `document.querySelector("[data-go=todo]").click(); await wait(300); const tb=[...document.querySelectorAll("#todos .tb")].pop(); tb.click(); await wait(400); $("del").click(); await wait(600); clearToasts(); const tr=document.querySelector(".trash, #trash-toggle, [aria-controls*=trash]"); if (tr) tr.click(); await wait(400); const tl=document.getElementById("trash-list"); if (tl) tl.scrollIntoView({block:"center"});`],
  ["07-提示条叠放", ``, `document.querySelector("[data-go=todo]").click(); await wait(300); for (let i=0;i<3;i++){ const ck=document.querySelector("#todos .td:not(.done) .ck"); if (ck) ck.click(); await wait(1200); } await wait(200);`],
];
const VIEWPORTS = [["手机", 390, 844, true], ["电脑", 1280, 860, false]];
const THEMES = ["light", "dark"];

async function cdp(wsUrl){
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id: i, method, params})); });
  return {send, close: () => ws.close()};
}

async function main(){
  if (!EDGE) throw new Error("没找到 Microsoft Edge");
  fs.mkdirSync(OUT, {recursive: true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "planner-shoot-"));
  const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], {stdio: "ignore"});
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++){
      try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = list.find(t => t.type === "page"); } catch(e){}
      if (!target) await sleep(200);
    }
    if (!target) throw new Error("Edge 没有启动");
    const c = await cdp(target.webSocketDebuggerUrl);
    await c.send("Page.enable"); await c.send("Runtime.enable");
    let errors = 0;
    for (const [vpName, w, hgt, mobile] of VIEWPORTS){
      for (const theme of THEMES){
        const scenes = mobile ? SCENES : SCENES.filter(s => ["00-今天-下一件事提醒状态", "01-今天-两种提醒", "03-新建-韩文识别"].includes(s[0]));
        for (const [name, hash, script] of scenes){
          await c.send("Emulation.setDeviceMetricsOverride", {width: w, height: hgt, deviceScaleFactor: 2, mobile});
          await c.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-color-scheme", value: theme}]});
          // 每个场景独立：先清空本机偏好（上次打开的页、主题等），再重新打开
          await c.send("Page.navigate", {url: URL}); await sleep(600);
          await c.send("Runtime.evaluate", {expression: "try { localStorage.clear(); } catch(e) {}"});
          await c.send("Page.navigate", {url: URL + hash}); await sleep(2200);
          const r = await c.send("Runtime.evaluate", {expression: `(async () => { ${PREP} ${script} return "ok"; })()`, awaitPromise: true});
          if (r.result && r.result.exceptionDetails){ errors++; console.log("场景出错：", name, r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description); }
          const shot = await c.send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
          const file = path.join(OUT, `${vpName}-${theme === "light" ? "浅色" : "深色"}-${name}.png`);
          fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
          console.log("截图：", path.relative(ROOT, file));
        }
      }
    }
    c.close();
    console.log(errors ? `完成，但有 ${errors} 个场景出错` : "完成");
  } finally {
    edge.kill();
  }
}
main().catch(e => { console.error("截图失败：", e.message); process.exit(1); });
