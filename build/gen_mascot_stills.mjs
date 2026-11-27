// 吉祥物静态图生成器（#833 吉祥物秒出）：今天页先显示静态图，Rive 第一帧画出来后同一帧换成会动的（src/motion/mascot-stage.ts）。
// 静态图就是 Rive 自己画的第一帧：用 Chromium（Playwright）跑同一份运行库，画布的位置、大小、像素比照舞台的同一个算法
// （src/motion/mascot-box.ts 的 stageBox，角色框按今天页的 .rv、3 倍屏），载入时设的输入、表情直达输入和舞台一样先设好，
// 取第一帧有角色像素的画面（同 mascot-box.ts 的 hasInk），无损 WebP（libwebp，@jsquash/webp）存进 src/features/mascot/assets/<名字>.still.webp。
// • 只出目录里公开的角色（catalog.ts 的 MASCOTS）；#2 是同人作品，不出静态图（文件不进仓库）
// • NO_STILL 里的不出：素材开场是从无到有的入场动画，第一帧几乎是空的，换过去会先消失再长出来；
//   其余的第一帧必须就是有角色的那一帧（第 0 帧），不是就报错——换了带入场动画的素材要先想清楚放不放静态图
// • src/features/mascot/assets/stills.json 记每张图对应的 .riv 的 sha256 和像素大小：--check 核对（单测 mascot-stills.test.ts 同样核），
//   换了 .riv 或改了角色框、裁切没重出，CI 报错
// 用法：node build/gen_mascot_stills.mjs            重新生成（要装好 Playwright 的 Chromium）
//       node build/gen_mascot_stills.mjs --check    只核对 stills.json 和 .riv、图片对得上，不开浏览器
//       node build/gen_mascot_stills.mjs --frames <目录>   另存每只的前 12 帧 PNG 和相邻帧差（查哪一帧开始有跳动用）
/* global window, document */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'src', 'features', 'mascot', 'assets');
export const MANIFEST = join(ASSETS, 'stills.json');
/** 静态图按 3 倍屏出（iPhone）；2 倍、1 倍屏由浏览器缩小 */
export const STILL_DPR = 3;

const { MASCOTS, MASCOT_IDS } = await import(pathToFileURL(join(ROOT, 'src', 'features', 'mascot', 'data', 'catalog.ts')).href);
const { stageBox } = await import(pathToFileURL(join(ROOT, 'src', 'motion', 'mascot-box.ts')).href);

/** 今天页角色框的大小：从 Mascot.module.css 的 .rv 读，改了样式这里跟着变 */
export function rvBox() {
  const css = readFileSync(join(ROOT, 'src', 'features', 'mascot', 'ui', 'Mascot.module.css'), 'utf8');
  const m = /\n\.rv \{([^}]*)\}/.exec(css);
  const w = m && /\swidth: (\d+)px;/.exec(m[1]);
  const h = m && /\sheight: (\d+)px;/.exec(m[1]);
  if (!w || !h) throw new Error('Mascot.module.css 里找不到 .rv 的 width、height');
  return [Number(w[1]), Number(h[1])];
}

/** 不出静态图的：#15 Milly 开场约 50 帧全透明，之后才从一小块长出来（入场动画） */
export const NO_STILL = ['15'];

/** 目录里资源地址的文件名（Node 里是 file: 地址，Vitest 里是 /src/... 路径，都取最后一段） */
const fileOf = (url) => basename(new URL(url, 'http://x/').pathname);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const stillName = (rivPath) => `${basename(rivPath, '.riv')}.still.webp`;

/** 每只要出的图：id、.riv 路径、静态图文件名、画布像素大小 */
export function plan() {
  const [W, H] = rvBox();
  return MASCOT_IDS.filter((id) => !NO_STILL.includes(id)).map((id) => {
    const d = MASCOTS[id];
    const riv = join(ASSETS, fileOf(d.url));
    const box = stageBox(d, W, H, STILL_DPR);
    return { id, d, riv, still: stillName(riv), box };
  });
}

/** stills.json、图片、.riv、目录里的 still 对不对得上：返回错误列表（单测 src/features/mascot/__tests__/mascot-stills.test.ts 也调） */
export function check() {
  const want = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const errors = [];
  for (const id of NO_STILL) if (MASCOTS[id]?.still) errors.push(`#${id} 在 NO_STILL 里，目录里不该写 still`);
  for (const p of plan()) {
    const url = p.d.still;
    if (!url || fileOf(url) !== p.still) errors.push(`#${p.id} 目录里的 still 应为 ../assets/${p.still}`);
    const got = want[p.id];
    if (!got) {
      errors.push(`#${p.id} 没有静态图：跑 node build/gen_mascot_stills.mjs`);
      continue;
    }
    if (got.file !== p.still) errors.push(`#${p.id} 静态图文件名 ${got.file} 应为 ${p.still}`);
    if (got.riv !== sha(readFileSync(p.riv))) errors.push(`#${p.id} 的 .riv 换过了，静态图没重出`);
    if (got.w !== p.box.pw || got.h !== p.box.ph) errors.push(`#${p.id} 静态图 ${got.w}×${got.h}，舞台画布是 ${p.box.pw}×${p.box.ph}（角色框或裁切改过）`);
    let img;
    try {
      img = readFileSync(join(ASSETS, got.file));
    } catch {
      errors.push(`#${p.id} 找不到 ${got.file}`);
      continue;
    }
    if (got.webp !== sha(img)) errors.push(`#${p.id} 的 ${got.file} 和 stills.json 记的不一样`);
  }
  for (const id of Object.keys(want)) if (!plan().some((p) => p.id === id)) errors.push(`stills.json 里多了 #${id}`);
  return errors;
}

/** 页面里跑：载入一只，取第一帧有角色像素的画面（和舞台同一个顺序：先设输入，再定画布大小，再画） */
const RENDER = async ({ p, frames }) => {
  const { Rive, RuntimeLoader } = window.rive;
  RuntimeLoader.setWasmUrl('/rive.wasm');
  RuntimeLoader.setWasmFallbackUrl(null);
  const buffer = await (await fetch(`/riv/${p.id}`)).arrayBuffer();
  const c = document.createElement('canvas');
  Object.assign(c.style, { position: 'absolute', left: '0', top: '0', width: `${p.box.w}px`, height: `${p.box.h}px` });
  document.body.replaceChildren(c);
  const ink = (d) => {
    const need = Math.min(20, Math.ceil(d.length / (4 * 16) / 20));
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 16) if ((d[i] ?? 0) > 230 && ++n >= need) return true;
    return false;
  };
  return new Promise((done, fail) => {
    const out = { first: null, frames: [] };
    let r = null;
    let loaded = false;
    const grab = () => {
      if (!loaded) return;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const has = ink(d);
      if (has && out.first === null) {
        let bin = '';
        const u8 = new Uint8Array(d.buffer);
        for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        out.first = { at: out.frames.length, rgba: btoa(bin), png: c.toDataURL('image/png') };
      }
      out.frames.push(frames ? c.toDataURL('image/png') : null);
      if ((out.first !== null && out.frames.length >= (frames ? 12 : 1)) || out.frames.length > 240) {
        r.cleanup();
        done(out);
      }
    };
    r = new Rive({
      buffer,
      canvas: c,
      ...(p.artboard ? { artboard: p.artboard } : {}),
      stateMachines: p.sm,
      autoplay: true,
      autoBind: p.novm !== true,
      enableRiveAssetCDN: false,
      onAdvance: () => queueMicrotask(grab),
      onLoad: () => {
        const sm = r.stateMachineInputs(p.sm) ?? [];
        for (const [name, v] of Object.entries(p.init ?? {})) {
          const i = sm.find((x) => x.name === name);
          if (i) i.value = v;
        }
        if (p.mood) {
          const i = sm.find((x) => x.name === p.mood.input);
          if (i) i.value = p.mood.value;
        }
        c.width = p.box.pw;
        c.height = p.box.ph;
        r.devicePixelRatioUsed = p.box.dpr;
        r.resizeToCanvas();
        loaded = true;
      },
      onLoadError: () => fail(new Error('load')),
    });
  });
};

/** 无损 WebP 编码器（libwebp 的 wasm，App 里存图也用这一份） */
async function webpEncoder() {
  const require = createRequire(import.meta.url);
  const wasmBinary = readFileSync(require.resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm'));
  const [codec, meta] = await Promise.all([import('@jsquash/webp/codec/enc/webp_enc_simd.js'), import('@jsquash/webp/meta.js')]);
  const mod = await codec.default({ noInitialRun: true, wasmBinary });
  return (rgba, w, h) => {
    const out = mod.encode(rgba, w, h, { ...meta.defaultOptions, lossless: 1, quality: 100, method: 6 });
    if (!out) throw new Error('webp encode');
    return Buffer.from(out);
  };
}

async function render(framesDir) {
  const { chromium } = await import('@playwright/test');
  const encode = await webpEncoder();
  const browser = await chromium.launch();
  const manifest = {};
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: STILL_DPR, viewport: { width: 800, height: 800 } });
    const page = await ctx.newPage();
    const items = plan();
    await page.route('http://stills.local/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="/rive.js"></script>' });
      if (path === '/rive.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(ROOT, 'node_modules', '@rive-app', 'canvas', 'rive.js')) });
      if (path === '/rive.wasm') return route.fulfill({ contentType: 'application/wasm', body: readFileSync(join(ROOT, 'node_modules', '@rive-app', 'canvas', 'rive.wasm')) });
      const it = items.find((x) => path === `/riv/${x.id}`);
      if (it) return route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(it.riv) });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://stills.local/');
    for (const it of items) {
      const d = it.d;
      const mood = d.moods ? { input: d.moods.input, value: d.moods.ring.indexOf(d.moods.rest) + 1 } : null;
      const p = { id: it.id, artboard: d.artboard, sm: d.sm ?? 'State Machine 1', novm: d.novm, init: d.init, mood, box: it.box };
      const out = await page.evaluate(RENDER, { p, frames: Boolean(framesDir) });
      if (!out.first) throw new Error(`#${it.id} 画了 240 帧都没有角色像素`);
      if (out.first.at !== 0) throw new Error(`#${it.id} 第 ${out.first.at} 帧才有角色像素（开场是入场动画）：放不放静态图先想清楚，不放就加进 NO_STILL`);
      const webp = encode(new Uint8ClampedArray(Buffer.from(out.first.rgba, 'base64')), it.box.pw, it.box.ph);
      writeFileSync(join(ASSETS, it.still), webp);
      manifest[it.id] = { file: it.still, riv: sha(readFileSync(it.riv)), webp: sha(webp), w: it.box.pw, h: it.box.ph, frame: out.first.at };
      if (framesDir) {
        const dir = join(framesDir, it.id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'still.png'), Buffer.from(out.first.png.split(',')[1], 'base64'));
        out.frames.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.png`), Buffer.from(f.split(',')[1], 'base64')));
      }
      console.log(`#${it.id} ${it.still} ${it.box.pw}×${it.box.ph} 第 ${out.first.at} 帧 ${webp.length} 字节`);
    }
  } finally {
    await browser.close();
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--check')) {
    const errors = check();
    if (errors.length > 0) {
      for (const e of errors) console.error(`✗ ${e}`);
      process.exit(1);
    }
    console.log(`吉祥物静态图：${plan().length} 张都和 .riv、舞台画布对得上`);
  } else {
    const i = process.argv.indexOf('--frames');
    await render(i > 0 ? process.argv[i + 1] : null);
  }
}
