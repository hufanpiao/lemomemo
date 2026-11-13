// ai-parse、ai-voice、claude-intake 单测共用的替身（B3 任务单 BE-4、BE-5）：门的依赖（同意、开关、配置、计数）全在内存里，
// 服务商是记账的桩（记下每次 generate 的请求，按脚本回结果），不碰网络、不调 Gemini。
import type { GateDeps, QuotaStore } from '../../supabase/functions/_shared/ai/gate.ts';
import type { AiConfig } from '../../supabase/functions/_shared/ai/router.ts';
import type { AiRequest, AiResult, AIProvider } from '../../supabase/functions/_shared/ai/provider.ts';
import type { AiKindLike, InvalidReasonLike } from '../../supabase/functions/_shared/ai/parse-core.ts';

export const UA = '0a1b2c3d-1111-4222-8333-444455556666';
/** counters 的 check 约束（0001） */
export const COUNTER_KEY = /^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$/;

export class StubProvider implements AIProvider {
  readonly name = 'stub';
  readonly model = 'stub-model';
  readonly calls: AiRequest[] = [];
  private readonly reply: (req: AiRequest) => AiResult | Promise<AiResult>;
  constructor(reply: (req: AiRequest) => AiResult | Promise<AiResult>) {
    this.reply = reply;
  }
  async generate(req: AiRequest): Promise<AiResult> {
    this.calls.push(req);
    return this.reply(req);
  }
}

export const okJson = (json: unknown): AiResult => ({ ok: true, json, raw: JSON.stringify(json) });

export interface FakeGate extends GateDeps {
  counts: Map<string, number>;
  logs: string[];
  invalid: { userId: string; src: string; reasons: InvalidReasonLike[] }[];
  /** 每次 markExhausted 写的值（按调用先后，含没生效的） */
  exhaustedAt: number[];
  /** 现在的 exhausted_until：和 store.ts 的 markExhausted 一样只往后延，exhaustedUntil() 读它 */
  readonly exhausted: number | null;
  provider: GateDeps['provider'] & { stub: StubProvider };
  setNow(ms: number): void;
}

export interface GateOpts {
  consent?: boolean | 'throw';
  features?: AiKindLike[] | ((userId: string, v: string) => Promise<AiKindLike[]>);
  config?: Partial<AiConfig> | 'throw';
  noProvider?: boolean;
  exhaustedUntil?: number | null;
  minuteLimitHit?: boolean;
  reply?: (req: AiRequest) => AiResult | Promise<AiResult>;
  now?: number;
}

/** 门的依赖：计数按 limit 判（超了不留），和 private.take_rate + store.ts 的 quotaStore 口径一致 */
export function fakeGate(o: GateOpts = {}): FakeGate {
  let now = o.now ?? Date.UTC(2026, 9, 28, 3, 0);
  const counts = new Map<string, number>();
  const logs: string[] = [];
  const invalid: FakeGate['invalid'] = [];
  const exhaustedAt: number[] = [];
  let exhausted = o.exhaustedUntil ?? null;
  const stub = new StubProvider(o.reply ?? (() => okJson({ items: [] })));
  const quota: QuotaStore = {
    async take(key, limit) {
      if (!COUNTER_KEY.test(key)) throw new Error(`bad key ${key}`);
      const c = (counts.get(key) ?? 0) + 1;
      if (c > limit) return null;
      counts.set(key, c);
      return c;
    },
    async refund(key) {
      const c = counts.get(key) ?? 0;
      if (c > 0) counts.set(key, c - 1);
    },
  };
  const provider = Object.assign((_cfg: AiConfig) => (o.noProvider ? null : stub), { stub });
  return {
    counts, logs, invalid, exhaustedAt, provider,
    get exhausted() { return exhausted; },
    setNow: (ms) => { now = ms; },
    async consent() {
      if (o.consent === 'throw') throw new Error('db');
      return o.consent ?? true;
    },
    async features(userId, v) {
      if (typeof o.features === 'function') return o.features(userId, v);
      return o.features ?? ['event', 'todo', 'note', 'anniv'];
    },
    async config() {
      if (o.config === 'throw') throw new Error('db');
      return { provider: 'gemini', model: 'gemini-x', per_user_daily: 50, global_daily: 1000, ...(o.config ?? {}) };
    },
    async rate(key, limit, windowS) {
      if (!COUNTER_KEY.test(key)) throw new Error(`bad key ${key}`);
      if (o.minuteLimitHit) return false;
      const c = (counts.get(key) ?? 0) + 1;
      counts.set(key, c);
      return c <= limit && windowS > 0;
    },
    quota,
    async exhaustedUntil() {
      return exhausted;
    },
    async markExhausted(until) {
      exhaustedAt.push(until);
      if (exhausted === null || exhausted < until) exhausted = until;
    },
    async logInvalid(userId, src, reasons) {
      invalid.push({ userId, src, reasons });
    },
    now: () => now,
    log: (c) => logs.push(c),
  };
}

/** 只数 ai:… 的个人、全局计数（不含每分钟） */
export const used = (g: FakeGate, prefix: string) => [...g.counts].filter(([k]) => k.startsWith(prefix)).reduce((s, [, v]) => s + v, 0);
