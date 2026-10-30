// 设置 › 数据 › 导出全部（R-256 ②；架构第 6 节 account、0.29 续第 93、96 条；0.47 第 4～16 条、0.47 续 ①③④ 起分片）
// • 由 SettingsPage 调用、结果经 props 交给 DataSection（前端审查建议 1）：进注销页等子页时 DataSection 卸载，任务不丢；
//   任务只在内存，离开设置页（整页卸载）就停在当前这片之后、不再取，回来只能重新导出（TC-B1-123 ⑥ 同口径）
// • 点“导出”：读本机设备行 id → start（扣一次当天次数）→ 按游标一片一片取（data/export-run.ts）→ 拼成一个文件
//   → 存文件（platform/save-file：电脑 download，iPhone 主屏幕版 share）。成功后留着这份文件，界面给“再存一次”
// • 取片中途停下（自动重试 2 次也没过）：状态 paused，界面写“导出中断了…”，给“继续”“取消”。
//   “继续”用同一个 export_id 和游标接着取，不再 start、不另算次数；只在开始后 1 小时内、同一个会话里有效（0.47 第 15 条），
//   到点自动变成“已过期”。“取消”只丢掉内存里的任务（服务器的任务 1 小时后自己过期，不另调接口）
// • 失败：start 回 rate_limited 是“每天 3 次用完”；part 回 rate_limited 是“当天分片用完”（parts_used_up，0.47 续 ⑥ 前端第 2 项）；
//   export_expired、export_too_large 各给各的提示；会话没了、停用、冷静期交 handleAccountLoss
// • onExported：服务器记下导出（start 成功）后、文件取完后各调一次，“最近的导出”据此重读（没取完的那条标“未完成”）
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountErr, AccountFailure, ExportFile } from '../data/account-api.ts';
import { jobExpired, newJob, runParts, EXPORT_RESUME_MS, type ExportJob } from '../data/export-run.ts';
import { handleAccountLoss, type AccountActionDeps } from './useAccountActions.ts';

/** “已取回 N MB”的数字（界面层不直接引 data，经这里转出） */
export { fmtMb } from '../data/export-run.ts';

/** 导出页的错误：服务器的码，另加“当天分片用完”和“账号太大、一次导不出”（start 的大小预检，0.47 续 ①“超大账号”） */
export type ExportErr = AccountErr | 'parts_used_up' | 'start_too_large';

export type ExportState =
  | { kind: 'idle' }
  /** bytes：已取回的字节数（还没取回第一片时为 0）；first：这一轮取回第一片时的字节数（还没取回为 0），读屏只在这时播报一次进度 */
  | { kind: 'busy'; bytes: number; first: number }
  /** 中断，可以“继续”：job 是停下时的进度 */
  | { kind: 'paused'; job: ExportJob }
  /** saved：这次存下了没有（取消分享、分享被拒要再点一下、download 抛错都为 false） */
  | { kind: 'done'; file: ExportFile; saved: boolean }
  | { kind: 'error'; error: ExportErr };

export interface ExportOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function useExport(d: AccountActionDeps, onExported?: () => void, o: ExportOptions = {}) {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  /** “再存一次”正在存（防连点：存的过程中按钮禁用） */
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const savingRef = useRef(false);
  const alive = useRef(true);
  const now = o.now ?? Date.now;
  const sleep = o.sleep;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const set = useCallback((s: ExportState): void => {
    if (alive.current) setState(s);
  }, []);

  /** 中断以后到 1 小时就不能继续了：到点改成“已过期” */
  const pausedJob = state.kind === 'paused' ? state.job : null;
  useEffect(() => {
    if (!pausedJob) return undefined;
    const left = pausedJob.startedAt + EXPORT_RESUME_MS - now();
    const timer = setTimeout(() => set({ kind: 'error', error: 'export_expired' }), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [pausedJob, now, set]);

  const store = useCallback(
    async (file: ExportFile): Promise<boolean> => {
      try {
        // 只有真存好了才算（取消、被拒要再点一下的都不算，界面给“再存一次”）
        const r = await d.save(file);
        return r === 'shared' || r === 'downloaded';
      } catch {
        return false;
      }
    },
    [d],
  );

  /** 失败交给离开本机的处理，或显示错误。fromPart：分片的 rate_limited 是“当天分片用完”；
   *  start 的 export_too_large 是大小预检拒了（原文估算超 480 MB、没扣次数），和分片超上限分开提示 */
  const fail = useCallback(
    (f: AccountFailure, fromPart: boolean): void => {
      const show = (error: ExportErr): void => set({ kind: 'error', error });
      if (handleAccountLoss(f, d, () => show('unknown'))) return;
      if (fromPart && f.error === 'rate_limited') show('parts_used_up');
      else if (!fromPart && f.error === 'export_too_large') show('start_too_large');
      else show(f.error);
    },
    [d, set],
  );

  const fetchRest = useCallback(
    async (job: ExportJob): Promise<void> => {
      set({ kind: 'busy', bytes: job.bytes, first: 0 });
      let first = 0;
      const out = await runParts(d.api, job, {
        now,
        ...(sleep ? { sleep } : {}),
        onProgress: (bytes) => {
          if (first === 0) first = bytes;
          set({ kind: 'busy', bytes, first });
        },
        stopped: () => !alive.current,
      });
      if (!alive.current) return;
      if (out.kind === 'paused') {
        set({ kind: 'paused', job: out.job });
        return;
      }
      if (out.kind === 'failed') {
        fail(out.failure, true);
        return;
      }
      onExported?.();
      const saved = await store(out.file);
      set({ kind: 'done', file: out.file, saved });
    },
    [d, now, sleep, set, fail, store, onExported],
  );

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    set({ kind: 'busy', bytes: 0, first: 0 });
    try {
      const r = await d.api.startExport(await d.readDeviceId());
      if (!alive.current) return;
      if (!r.ok) {
        fail(r, false);
        return;
      }
      onExported?.();
      await fetchRest(newJob(r.value, now()));
    } finally {
      running.current = false;
    }
  }, [d, now, set, fail, fetchRest, onExported]);

  /** 继续：同一个任务、同一个游标，不再 start、不另算次数 */
  const resume = useCallback(async () => {
    if (running.current || state.kind !== 'paused') return;
    const job = state.job;
    if (jobExpired(job, now())) {
      set({ kind: 'error', error: 'export_expired' });
      return;
    }
    running.current = true;
    try {
      await fetchRest(job);
    } finally {
      running.current = false;
    }
  }, [state, now, set, fetchRest]);

  /** 取消：丢掉内存里的任务 */
  const cancel = useCallback(() => {
    if (running.current) return;
    set({ kind: 'idle' });
  }, [set]);

  /** 再存一次（不再调服务器） */
  const saveAgain = useCallback(async () => {
    if (state.kind !== 'done' || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await store(state.file);
      set({ kind: 'done', file: state.file, saved });
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }, [state, store, set]);

  return { state, saving, run, resume, cancel, saveAgain };
}

/** 设置页（SettingsPage）持有的导出任务，交给 DataSection 显示 */
export type ExportTask = ReturnType<typeof useExport>;
