// 职责：提示音与推送的平台接口。ui/remind.js 只调用这里，不直接碰 Web Audio、震动或浏览器通知。
//       chime()：页面开着时到点响一声提示音（Web Audio 合成两声短音，不加载外部文件）。浏览器要求先有一次用户操作
//       才能出声，所以第一次点按或按键时解锁；还没解锁时返回 false。能震动的设备顺带震一下（iPhone Safari 不支持，会忽略）。
//       页面关闭时的推送：claude.ai 版不支持（改由 Claude 定时任务推送，ADR-005）；独立服务器 PWA 版再实现 Web Push。
// 依赖：platform/index.js
App.platform = App.platform || {};

let audio = null;
function unlock(){
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    if (!audio) audio = new AC();
    if (audio.state === "suspended") audio.resume();
  } catch(e){ audio = null; }
}
if (typeof addEventListener === "function"){
  addEventListener("pointerdown", unlock, {passive:true});
  addEventListener("keydown", unlock);
}

// 两声短音：880Hz 再 660Hz，各 120 毫秒，柔和起落，避免爆音
function chime(){
  // 用户还没点过页面时浏览器会拦截震动，所以只在解锁之后震
  const ua = globalThis.navigator && navigator.userActivation;
  const active = ua ? ua.hasBeenActive : !!audio;
  try { if (active && navigator.vibrate) navigator.vibrate([60, 40, 60]); } catch(e){}   // D17：没点过页面时不调用
  if (!audio || audio.state !== "running") return false;
  const t0 = audio.currentTime;
  [[880, 0], [660, 0.16]].forEach(([f, at]) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.12);
    o.connect(g).connect(audio.destination);
    o.start(t0 + at); o.stop(t0 + at + 0.14);
  });
  return true;
}

App.platform.notify = {
  chime,
  pushSupported: () => false,
  requestPermission: async () => "unsupported",
  // 推送文字要脱敏：只写“10:00 1 项日程（NEOX）”这类时间加项目简称，不带完整标题、备注和地点（安全审查）
  push: async () => false,
};
