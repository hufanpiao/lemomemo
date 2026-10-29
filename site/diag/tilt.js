// 倾斜授权试验页（R-153，架构 0.27 第 5 点；iPhone 实机验收清单 P1-05）。
// 要回答的只有一件事：主屏幕版里允许了“动作与方向”以后，从后台彻底划掉再打开，授权还在不在。
// 做法：
//   ① 页面一打开就挂上 deviceorientation、devicemotion 监听，但不调 requestPermission（加载时调会被 iOS 拒绝，也违反 0.27 第 5 点）。
//      iOS 没授权时这两个事件一个都不来，所以“没点按就收到了读数”= 授权还在；2 秒内什么都没收到 = 授权不在。
//   ② 按钮的点按回调里同步调用 DeviceOrientationEvent / DeviceMotionEvent 的 requestPermission（两个都在同一次点按里发起，
//      不等第一个回来再调第二个，免得第二个已经不算“用户点按里”），显示结果和用了多少毫秒。
//   ③ 实时显示倾角和重力读数，并按试验页第 2 版的算法挪动一块高光，倾斜时看得出跟不跟手。
// 隐私：读数只放内存、只写进本页的文字；不用 localStorage / sessionStorage / IndexedDB / Cookie，不发任何请求，不打日志。
// 导出的函数给 src/app/__tests__/tilt-diag.test.ts 用。页面在 /diag/tilt.html（/app/ 作用域外，SW-update ③）。

/** 打开后等多久没收到读数就判“授权不在” */
export const AUTO_WAIT_MS = 2000;

/** 高光位置：照液态玻璃试验页第 2 版（docs/02-设计/皮肤-v4/液态玻璃-真机试验.html 的 onTilt）。左右歪 gamma 挪横向，前后仰 beta 挪纵向 */
export function highlightPos(beta, gamma) {
  const g = Math.max(-35, Math.min(35, gamma ?? 0));
  const b = Math.max(0, Math.min(90, beta ?? 45));
  return { sx: 50 + g * 1.6, sy: -30 + (45 - b) * 0.6 };
}

/** 角度显示到 0.1°；读不到时显示破折号 */
export function fmtDeg(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}°` : '—';
}

/** 加速度显示到 0.01 m/s² */
export function fmtAcc(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
}

/** 这个浏览器的这个接口要不要先授权（iOS 13 起的 Safari 有 requestPermission） */
export function needsPermission(Ctor) {
  return typeof Ctor?.requestPermission === 'function';
}

/** requestPermission 的结果换成中文；原值放在括号里方便核对 */
export function describeResult(r) {
  if (r === 'granted') return '允许（granted）';
  if (r === 'denied') return '拒绝（denied）';
  return `其他（${String(r)}）`;
}

/**
 * 发起一个接口的授权请求。必须在点按回调里同步调用（本函数在返回 Promise 之前就已经调了 requestPermission）。
 * 返回的 Promise 不会 reject：结果一律是给人看的中文。
 */
export function startRequest(Ctor) {
  if (!Ctor) return Promise.resolve('这个浏览器没有这个接口');
  if (!needsPermission(Ctor)) return Promise.resolve('不需要授权（没有 requestPermission，不是 iPhone 的 Safari）');
  let p;
  try {
    p = Promise.resolve(Ctor.requestPermission());
  } catch (e) {
    return Promise.resolve(`出错：${e?.name ?? '未知错误'}`);
  }
  return p.then(describeResult, (e) => `出错：${e?.name ?? '未知错误'}`);
}

function setRow(dl, doc, key, value) {
  let dd = dl.querySelector(`dd[data-k="${key}"]`);
  if (!dd) {
    const dt = doc.createElement('dt');
    dt.textContent = key;
    dd = doc.createElement('dd');
    dd.dataset.k = key;
    dl.append(dt, dd);
  }
  if (dd.textContent !== value) dd.textContent = value;
}

function clock(win) {
  const d = new win.Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 填页面并挂监听；doc、win 由调用方给（测试里给 jsdom 和假的 window） */
export function run(doc, win) {
  const t0 = win.performance.now();
  const ms = () => Math.round(win.performance.now() - t0);
  const env = doc.getElementById('env');
  const perm = doc.getElementById('perm');
  const live = doc.getElementById('live');
  const auto = doc.getElementById('auto');
  const glass = doc.getElementById('glass');
  const button = doc.getElementById('ask');
  const DOE = win.DeviceOrientationEvent;
  const DME = win.DeviceMotionEvent;
  const askable = needsPermission(DOE) || needsPermission(DME);

  const nav = win.performance.getEntriesByType?.('navigation')?.[0]?.type ?? '读不到';
  setRow(env, doc, '打开方式', win.navigator.standalone === true ? '主屏幕版' : '浏览器里打开（不是主屏幕版）');
  setRow(env, doc, '本页这次打开于', `${clock(win)}（划掉重开后这个时间会变）`);
  setRow(env, doc, '打开类型', String(nav));
  setRow(env, doc, '这个浏览器要不要授权', askable ? '要（有 requestPermission）' : '不要（没有 requestPermission，这一页的结论只对 iPhone 有意义）');

  // 只放内存
  // tapped：自动检测出结果前就点了按钮；touched：任何时候点过按钮
  const st = { tapped: false, touched: false, decided: false, firstData: -1, orient: 0, motion: 0 };
  const late = doc.getElementById('late');

  const decide = (text, kind) => {
    if (st.decided) return;
    st.decided = true;
    auto.textContent = text;
    auto.dataset.verdict = kind;
  };

  const gotData = () => {
    const first = st.firstData < 0;
    if (first) st.firstData = ms();
    // 已判“记不住”，之后没点过按钮却来了第一笔读数：可能只是传感器起得慢，结论不可靠
    if (first && st.decided && auto.dataset.verdict === 'lost' && !st.touched) {
      late.textContent = `第 ${st.firstData} 毫秒才收到读数，结论可能有误，请重测`;
      late.hidden = false;
    }
    if (st.tapped) return;
    decide(
      askable
        ? `✔ 没点按钮就收到了读数（打开后 ${st.firstData} 毫秒）：授权还在 → 记得住`
        : `这个浏览器不需要授权，打开就有读数（${st.firstData} 毫秒）；要在 iPhone 上测才有结论`,
      askable ? 'kept' : 'n/a',
    );
  };

  const timer = win.setTimeout(() => {
    decide(
      askable
        ? `✘ 打开后 ${AUTO_WAIT_MS / 1000} 秒内没点按钮也没收到读数：授权不在 → 记不住（第一次装好、还没允许过时也是这样）`
        : `打开后 ${AUTO_WAIT_MS / 1000} 秒内没收到读数：这台设备可能没有方向传感器`,
      askable ? 'lost' : 'none',
    );
  }, AUTO_WAIT_MS);

  const onOrient = (e) => {
    if (typeof e.beta !== 'number' && typeof e.gamma !== 'number') return;
    st.orient += 1;
    gotData();
    setRow(live, doc, '前后仰（beta）', fmtDeg(e.beta));
    setRow(live, doc, '左右歪（gamma）', fmtDeg(e.gamma));
    setRow(live, doc, '朝向（alpha）', fmtDeg(e.alpha));
    setRow(live, doc, '方向事件次数', String(st.orient));
    const { sx, sy } = highlightPos(e.beta, e.gamma);
    glass.style.setProperty('--sx', `${sx.toFixed(1)}%`);
    glass.style.setProperty('--sy', `${sy.toFixed(1)}%`);
  };

  const onMotion = (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || (typeof a.x !== 'number' && typeof a.y !== 'number' && typeof a.z !== 'number')) return;
    st.motion += 1;
    gotData();
    setRow(live, doc, '重力加速度 x / y / z（m/s²）', `${fmtAcc(a.x)} / ${fmtAcc(a.y)} / ${fmtAcc(a.z)}`);
    setRow(live, doc, '动作事件次数', String(st.motion));
  };

  setRow(live, doc, '前后仰（beta）', '—');
  setRow(live, doc, '左右歪（gamma）', '—');
  setRow(live, doc, '朝向（alpha）', '—');
  setRow(live, doc, '方向事件次数', '0');
  setRow(live, doc, '重力加速度 x / y / z（m/s²）', '— / — / —');
  setRow(live, doc, '动作事件次数', '0');
  win.addEventListener('deviceorientation', onOrient);
  win.addEventListener('devicemotion', onMotion);

  button.addEventListener('click', () => {
    st.touched = true;
    if (!st.decided) {
      st.tapped = true;
      win.clearTimeout(timer);
      decide('点按钮时自动检测还没出结果，这次不算：请从后台划掉重开，2 秒内不要点按钮', 'early');
    }
    const t = win.performance.now();
    // 两个请求都在这一次点按里同步发起
    const reqs = [
      ['DeviceOrientationEvent', startRequest(DOE)],
      ['DeviceMotionEvent', startRequest(DME)],
    ];
    for (const [name] of reqs) setRow(perm, doc, name, '等待结果…');
    for (const [name, p] of reqs) {
      p.then((text) => setRow(perm, doc, name, `${text}，用了 ${Math.round(win.performance.now() - t)} 毫秒`));
    }
  });

  return st;
}

if (typeof document !== 'undefined' && document.getElementById('tilt-diag')) {
  run(document, window);
}
