// 首屏画完以后才加载的启动件（B2 FA-6 ③）：同步传输层（platform/sync-net → supabase-js 的封装、shared/schema/sync 带 zod）、
// 同步接线（app/sync-wiring → core/sync，带 shared/schema/rows、rows-read）、设备登记（core/device-reg）、账号状态探测（platform/account-status）。
// 原来 main.tsx 静态 import 它们，虽然 ① 已经把“调用”推到首屏画完以后，代码本身（含 zod 约 28 KB gzip）仍在首屏的下载里。
// main.tsx 在 appPainted() 之后用 startAfterPaint 下载（③ 审查 M1）：失败、超时按退避重试，恢复网络、切回前台立刻再试，
// 每次下载前、回来后都过换账号闸；连续失败几次出“同步暂停 · 重新打开”。严格校验的 rows 也在这里预加载（M2、L1：第一次写入不用等下载）。
import type { createDeviceRegistrar } from '../core/device-reg.ts';
import { loadRowSchemas } from '../core/outbox-logic.ts';
import type { Lifecycle } from '../platform/net.ts';
import type { LogUpload } from '../core/log/queue.ts';
import type { probeAccountForExit } from '../platform/account-status.ts';
import type { createSupabaseTransport } from '../platform/sync-net.ts';
import type { wireSync } from './sync-wiring.ts';

export interface AfterPaint {
  createSupabaseTransport: typeof createSupabaseTransport;
  createDeviceRegistrar: typeof createDeviceRegistrar;
  wireSync: typeof wireSync;
  probeAccountForExit: typeof probeAccountForExit;
}

/** 四个分包并行下载，顺带预加载入队严格校验要的 rows（③ 审查 M2、L1）；任何一个失败就整体失败（startAfterPaint 重试） */
export async function loadAfterPaint(): Promise<AfterPaint> {
  const [net, dev, wiring, status] = await Promise.all([
    import('../platform/sync-net.ts'),
    import('../core/device-reg.ts'),
    import('./sync-wiring.ts'),
    import('../platform/account-status.ts'),
    loadRowSchemas(),
  ]);
  return {
    createSupabaseTransport: net.createSupabaseTransport,
    createDeviceRegistrar: dev.createDeviceRegistrar,
    wireSync: wiring.wireSync,
    probeAccountForExit: status.probeAccountForExit,
  };
}

/**
 * 日志上传（platform/supabase/log-upload.ts）的懒加载版：日志队列在首屏之前就建好，但第一次真上传（主页、在线、有日志）时才加载 sync-net。
 * 只加载一次；加载失败这一批回 'retry'（和上传超时、断网同一种结果，队列留着下次再传），下次再试着加载
 */
export function lazyLogUploader(
  load: () => Promise<{ createLogUploader: () => LogUpload }> = () => import('../platform/sync-net.ts'),
): LogUpload {
  let pending: Promise<LogUpload> | null = null;
  return async (rows) => {
    const p = (pending ??= load().then((m) => m.createLogUploader()));
    let upload: LogUpload;
    try {
      upload = await p;
    } catch {
      if (pending === p) pending = null;
      return 'retry';
    }
    return upload(rows);
  };
}

/** 一次下载最多等多久，超时按失败算、进入重试（import() 一直挂着时也会重试、记日志；那次真到了照样用） */
export const AFTER_PAINT_TIMEOUT_MS = 15_000;
/** 第 n 次失败以后隔多久再试（超出的按最后一个，最长 5 分钟） */
export const AFTER_PAINT_RETRY_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000];
/** 连续失败这么多次出提示（main.tsx：顶部“同步暂停 · 重新打开”） */
export const AFTER_PAINT_NOTICE_AT = 3;

export interface StartAfterPaintDeps<T> {
  load: () => Promise<T>;
  /** 换账号闸：每次下载前、回来后都查，false 就收手（不再重试），调 onAbandoned */
  stillOwner: () => boolean;
  onLoaded: (m: T) => void;
  /** 第 n 次连续失败（error：下载出错；timeout：超过 timeoutMs 没回来） */
  onFailed: (n: number, why: 'error' | 'timeout') => void;
  onAbandoned: () => void;
  life: Pick<Lifecycle, 'onOnline' | 'onVisibility'>;
  timeoutMs?: number;
  retryMs?: readonly number[];
}

/**
 * 首屏画完以后下载启动件，直到成功或换了账号（③ 审查 M1）：
 * • 失败、超时以后按 retryMs 退避重试；恢复网络、切回前台时立刻再试（正在下载时不重复发起）；
 * • 每次下载前查一次闸，回来再查一次（超时以后那次才回来也一样）；闸不过就收手，onLoaded 不会被调；
 * • onLoaded 最多调一次。返回停止函数（测试用；页面里换账号会整页重新载入）
 */
export function startAfterPaint<T>(d: StartAfterPaintDeps<T>): () => void {
  const timeoutMs = d.timeoutMs ?? AFTER_PAINT_TIMEOUT_MS;
  const retryMs = d.retryMs ?? AFTER_PAINT_RETRY_MS;
  let done = false;
  let inFlight = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubs: (() => void)[] = [];
  const stop = (): void => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const u of unsubs.splice(0)) u();
  };
  const abandon = (): void => {
    stop();
    d.onAbandoned();
  };
  const attempt = (): void => {
    if (done || inFlight) return;
    if (!d.stillOwner()) return abandon();
    inFlight = true;
    let settled = false;
    const fail = (why: 'error' | 'timeout'): void => {
      if (settled || done) return;
      settled = true;
      inFlight = false;
      failures += 1;
      d.onFailed(failures, why);
      if (done) return;
      timer = setTimeout(() => {
        timer = null;
        attempt();
      }, retryMs[Math.min(failures, retryMs.length) - 1] ?? 300_000);
    };
    const t = setTimeout(() => fail('timeout'), timeoutMs);
    let p: Promise<T>;
    try {
      p = d.load();
    } catch {
      p = Promise.reject(new Error('after_paint_load_threw'));
    }
    p.then(
      (m) => {
        clearTimeout(t);
        if (!settled) {
          settled = true;
          inFlight = false;
        }
        if (done) return;
        if (!d.stillOwner()) return abandon();
        stop();
        d.onLoaded(m);
      },
      () => {
        clearTimeout(t);
        fail('error');
      },
    );
  };
  const wake = (): void => {
    if (done || inFlight || failures === 0) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    attempt();
  };
  unsubs.push(d.life.onOnline(wake), d.life.onVisibility((v) => v && wake()));
  attempt();
  return stop;
}
