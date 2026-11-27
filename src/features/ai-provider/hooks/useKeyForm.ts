// 填模型名、贴密钥、试一下：管理员的密钥详情页、我的 AI 的“用我自己的密钥”共用这一份
// • 密钥只在这个 hook 的 state 里（输入框受控）：不写 localStorage、不写库、不进地址、不进日志；组件卸载就没了；存好以后清掉
// • 已经有一把（saved.has：我的 AI 是存过、管理员页是服务器回的 has_key，Gemini 只配了环境变量也算）：输入框先显示“••••后四位 重贴”，
//   点“重贴”才出空的密码框；不贴新的 = 用库里那把试、存（契约 key 可不带）
// • “试一下”的结果只对试的那一刻的输入算数：服务商、模型名、密钥任何一样改了，结果作废（变回没试过），“保存 / 改用这把密钥”跟着变灰；
//   试到一半改了输入，回来的结果也不要（seq）
// • 运行日志只记动作名、服务商名、结果码、耗时（不记模型名、密钥）
import { useCallback, useRef, useState } from 'react';
import type { KeyOwnerName, TestFailCode } from '../../../../shared/schema/ai-provider.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { adminTest, ownTest, type KeyReq, type ProvErr, type ProvResult } from '../data/provider-api.ts';
import { canTest, needsModel } from '../data/rules.ts';
import type { TestRes } from '../../../../shared/schema/ai-provider.ts';

export type TestView =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; ms: number }
  /** status：服务商回的 HTTP 状态码（有就写进正文，照稿子“回的是 401（认不出这把密钥）”） */
  | { kind: 'fail'; code: TestFailCode; status: number | null }
  /** 没试成（断网、限速、没登录……）：不是密钥的问题，写一句话 */
  | { kind: 'err'; err: ProvErr };

export interface Saved {
  model: string | null;
  last4: string | null;
  /** 有没有一把能用的（见文件头） */
  has: boolean;
}

export interface KeyForm {
  model: string;
  key: string;
  /** 已经有一把（不贴新的就用它） */
  hasSaved: boolean;
  /** 要不要填模型名（联网搜索的 Brave、Tavily 不用） */
  withModel: boolean;
  /** 正在贴新密钥（已存过的点了“重贴”，或者本来就没存过） */
  pasting: boolean;
  test: TestView;
  /** 模型名对、密钥有（新贴的格式对或库里有） */
  canTest: boolean;
  /** 试通了（对当前输入）：“保存 / 改用这把密钥”能点 */
  passed: boolean;
  setModel(v: string): void;
  setKey(v: string): void;
  repaste(): void;
  run(): Promise<void>;
  /** 要发给服务器的那一份（存、改用时用；key 空 = 用库里那把） */
  req(): KeyReq;
  /** 存好以后：清掉贴的密钥、回到“••••后四位”，试的结果保留 */
  settle(): void;
}

const VIEW_OF = (r: ProvResult<TestRes>): TestView =>
  !r.ok ? { kind: 'err', err: r.err } : r.value.ok ? { kind: 'ok', ms: r.value.ms } : { kind: 'fail', code: r.value.code, status: r.value.status ?? null };

/** who：own（我的 AI，own_test）或 admin（admin_test）；provider 为 null 时还没选（我的 AI 里没点哪家） */
export function useKeyForm(who: 'own' | 'admin', provider: KeyOwnerName | null, saved: Saved | null): KeyForm {
  const hasSaved = saved?.has === true;
  const [model, setModelRaw] = useState(saved?.model ?? '');
  const [key, setKeyRaw] = useState('');
  const [pasting, setPasting] = useState(!hasSaved);
  const [test, setTest] = useState<TestView>({ kind: 'idle' });
  const seq = useRef(0);
  const touch = (): void => {
    seq.current += 1;
    setTest({ kind: 'idle' });
  };
  const setModel = useCallback((v: string): void => {
    touch();
    setModelRaw(v);
  }, []);
  const setKey = useCallback((v: string): void => {
    touch();
    setKeyRaw(v);
  }, []);
  const repaste = useCallback((): void => {
    touch();
    setPasting(true);
    setKeyRaw('');
  }, []);
  const withModel = provider === null || needsModel(provider);
  const ready = provider !== null && canTest(model, key, hasSaved, withModel, provider);
  const req = (): KeyReq => ({ provider: provider ?? 'gemini', model, key });
  const run = async (): Promise<void> => {
    if (!ready || provider === null || test.kind === 'busy') return;
    const mine = ++seq.current;
    setTest({ kind: 'busy' });
    const at = clock.now();
    const r = await (who === 'own' ? ownTest : adminTest)({ provider, model, key });
    rlog(`aiprov ${who}_test p=${provider} ${r.ok ? (r.value.ok ? 'pass' : `fail=${r.value.code}`) : `err=${r.err}`} ms=${Math.round(clock.now() - at)}`);
    if (seq.current === mine) setTest(VIEW_OF(r));
  };
  const settle = (): void => {
    setKeyRaw('');
    setPasting(false);
  };
  return { model, key, hasSaved, withModel, pasting, test, canTest: ready, passed: test.kind === 'ok', setModel, setKey, repaste, run, req, settle };
}
