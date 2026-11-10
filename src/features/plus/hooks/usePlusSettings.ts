// 设置 › 语音与 AI、在 Claude 聊天里记事 两节的状态（B3 FA-4）：数据层在 ../data/ai-usage-api.ts、claude-link-api.ts，麦克风在 platform/perm-mic.ts
// • 用量：进页面读一次；读不出来写“读不出来”，不当 0 次；恢复时刻按 current_tz 算（R-187）
// • 麦克风：exe 不做语音（R-90），返回 null、界面不显示这一行
// • AI 整理（R-369，架构 15.5 第三轮安全 X5）：显示读本机 settings 的 ai.enabled；关掉经 core/ai-settings 的唯一写法写 false；
//   打开一律先去告知页（#/onboarding/ai），本人勾选同意后由告知页记同意、写 true，再回到 设置 › 语音与 AI。
//   客户端读不到“同意是否有效”，所以不分情况一律走告知页；不能只改 ai.enabled，也不能不经告知页调 record_consent
// • 连接码：进页面读一次连着没有；新生成的明文码只放在这个 hook 的 state 里（离开这一页就没了，不存、不进日志）
import { useCallback, useEffect, useRef, useState } from 'react';
import { navigateSub } from '../../../app/router.ts';
import { quotaResetClock } from '../../../../shared/logic/ai-quota.ts';
import { writeAiSwitch } from '../../../core/ai-settings.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { settingValue, type SettingRow } from '../../../core/setting-read.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { micPermission, type MicState } from '../../../platform/perm-mic.ts';
import { readAiUsage, type AiUsage, type UsageDeps } from '../data/ai-usage-api.ts';
import { createLink, disconnectAll, linkStateOf, listLinks, type LinkDeps, type LinkErr, type LinkState, type NewCode } from '../data/claude-link-api.ts';

/** 时间按哪个时区显示（current_tz → 本机；ui 层不能直接引 core） */
export function useShowTz(): string {
  return currentTz();
}

export type UsageView = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; usage: AiUsage; resetAt: string };

/** 今天 AI 用量 + 恢复时刻（HH:MM，按 current_tz） */
export function useAiUsage(deps?: UsageDeps): UsageView {
  const [v, setV] = useState<UsageView>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void readAiUsage(deps).then((r) => {
      if (!live) return;
      setV(r.ok ? { kind: 'ok', usage: r.value, resetAt: quotaResetClock(clock.now(), currentTz()) } : { kind: 'error' });
    });
    return () => {
      live = false;
    };
  }, [deps]);
  return v;
}

/** 麦克风状态；exe 里是 null（不显示） */
export function useMicState(read: () => Promise<MicState> = micPermission, exe: boolean = isTauri()): MicState | null {
  const [v, setV] = useState<MicState | null>(exe ? null : 'unknown');
  useEffect(() => {
    if (exe) return undefined;
    let live = true;
    void read().then((s) => {
      if (live) setV(s);
    });
    return () => {
      live = false;
    };
  }, [read, exe]);
  return v;
}

export type LinkView = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; state: LinkState };

export interface ClaudeLink {
  view: LinkView;
  /** 刚生成的连接码（只显示这一次） */
  code: NewCode | null;
  busy: 'create' | 'disconnect' | null;
  /** 最近一次操作的结果：错误码，或 'disconnected'（刚断开） */
  notice: LinkErr | 'disconnected' | null;
  create(): Promise<void>;
  disconnect(): Promise<void>;
}

export function useClaudeLink(deps?: LinkDeps): ClaudeLink {
  const [view, setView] = useState<LinkView>({ kind: 'loading' });
  const [code, setCode] = useState<NewCode | null>(null);
  const [busy, setBusy] = useState<ClaudeLink['busy']>(null);
  const [notice, setNotice] = useState<ClaudeLink['notice']>(null);
  const live = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const r = await listLinks(deps);
    if (live.current) setView(r.ok ? { kind: 'ok', state: linkStateOf(r.value, clock.now()) } : { kind: 'error' });
  }, [deps]);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  // 安全审 3：页面切到后台就清掉明文码（只显示这一次，切回来也不再显示）
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') setCode(null);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 代码审 S2：busy 是 state，要等重渲染才灰掉；用 ref 防手快连点发出两次
  const running = useRef(false);

  const create = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setBusy('create');
    setNotice(null);
    try {
      const r = await createLink(deps);
      if (!live.current) return;
      if (!r.ok) {
        setNotice(r.err);
        // 安全审 2：超时等出错时请求可能已经在服务器上做完了，按服务器重读一次开关状态
        await load();
        return;
      }
      // 复审 R1：请求在路上时页面切到了后台，回包不显示明文码（同“切到后台就清掉”）；码已经有效，按服务器重读开关状态
      if (document.visibilityState === 'hidden') {
        await load();
        return;
      }
      setCode(r.value);
      // 新码已经有效：连着了，最后使用时间不变（新码还没被用过），连接日期是现在
      const now = clock.now();
      setView((v) => ({ kind: 'ok', state: { connected: true, lastUsedMs: v.kind === 'ok' ? v.state.lastUsedMs : null, madeMs: now } }));
    } finally {
      running.current = false;
      if (live.current) setBusy(null);
    }
  }, [deps, load]);

  const disconnect = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setBusy('disconnect');
    setNotice(null);
    try {
      const r = await disconnectAll(deps);
      if (!live.current) return;
      if (r.ok) setCode(null); // 刚生成、还没用的码也一起作废了，不再显示
      // 安全审 1、2：不凭 PATCH 没报错就说“已断开”（账号不是 active 时 RLS 一行不改也不报错；超时可能其实已断开），按服务器重读
      const back = await listLinks(deps);
      if (!live.current) return;
      if (!back.ok) {
        setView({ kind: 'error' });
        if (!r.ok) setNotice(r.err);
        return;
      }
      const state = linkStateOf(back.value, clock.now());
      setView({ kind: 'ok', state });
      if (state.connected) setNotice(r.ok ? 'failed' : r.err);
      else setNotice('disconnected');
    } finally {
      running.current = false;
      if (live.current) setBusy(null);
    }
  }, [deps]);

  return { view, code, busy, notice, create, disconnect };
}

export interface AiOrganizeDeps {
  /** 关掉：写 ai.enabled = false（默认 core/ai-settings.ts 的 writeAiSwitch） */
  turnOff?(): Promise<{ ok: boolean }>;
  /** 打开：去告知页（默认 #/onboarding/ai，做完回 设置 › 语音与 AI） */
  toConsent?(): void;
}

const defaultTurnOff = (): Promise<{ ok: boolean }> => writeAiSwitch({ key: 'ai.enabled', value: false });
const defaultToConsent = (): void => void navigateSub('onboarding', 'ai');

export interface AiOrganize {
  on: boolean;
  /** 关掉时本机写不进（库不可用等） */
  failed: boolean;
  set(v: boolean): void;
}

/** 设置 › 语音与 AI 的“AI 整理”开关，和首页那一行的“AI 整理已打开 / 已关闭” */
export function useAiOrganize(deps: AiOrganizeDeps = {}): AiOrganize {
  const settings = useCollection<SettingRow & { id: string }>('settings');
  const on = settingValue(settings, 'ai.enabled') === true;
  const [failed, setFailed] = useState(false);
  const { turnOff = defaultTurnOff, toConsent = defaultToConsent } = deps;
  const set = useCallback(
    (v: boolean): void => {
      setFailed(false);
      if (v) {
        toConsent();
        return;
      }
      // 代码审 S5：写不进或抛错都显示“没关上”
      turnOff().then(
        (r) => {
          if (!r.ok) setFailed(true);
        },
        () => setFailed(true),
      );
    },
    [turnOff, toConsent],
  );
  return { on, failed, set };
}
