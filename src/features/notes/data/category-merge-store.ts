// 合并相近分类的本机部分（B4 S7；TC-B4-07；R-413）：哪几对该提示、用户点过“不用”的记在 settings notes.merge_dismissed、执行合并。
// 不变量：notes.merge_dismissed 的值是 [[小 id, 大 id], …]，最多 PAIRS_MAX 对，满了去最旧的，每次写顺带去掉分类不活着的对；点过的一对不分方向都不再提示。
//   要提示的 = AI 判的（notes.merge_suggest：只有 ai-classify 写、这里的代码只读，但 RLS 不拦本人写，读时 idPairs 丢坏项）+ 本机三条规则判的，口径在 shared 的 openPairs。
//   执行合并只写被合并分类一笔 merged_into（不软删、不逐条改随手记）：条目在读的时候由 note-list.ts 的 categoryResolver 归到留下的分类
//   （列表、分类胶囊、编辑页的 formOf 都经它；新读 notes.category_id 的地方也必须经它）。
//   两台设备各合并一次绕成圈：fixCategoryCycles 给圈里留下的那个写回 merged_into: null（每个分类只写一次）。
//   合并后的撤销条（R-415 ③，8 秒，和删除同一个 kit UndoToast）点“撤销”：undoMerge 丢掉 outbox 里发送失败的合并那一笔，本机还合并着就写一笔 null，
//   最后把这一对记进“不用”（负责人 11-13：撤销就当点了“不用”，经 dismissMerge；写 null 没写成不记）。顺序见 undoMerge。
//   “写回 merged_into: null”只在 unmerge 一处，成环写回、撤销合并共用，都经 outbox。
//   运行日志（不记分类名）：notes merge category|undo|dismiss <结果码> merge=<id> keep=<id>，合并那行再带 why=ai|rule；抛异常记 threw <错误名>（platform 的 errName）
// 纯 TS，不准 React（A1）
import { isLiveCategory } from '../../../../shared/logic/live-row.ts';
import {
  idPairs, MERGE_DISMISSED_KEY, MERGE_SUGGEST_KEY, openPairs, withPairs, type MergePair,
} from '../../../../shared/logic/notes/category-merge.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { getBoot } from '../../../core/boot.ts';
import { saveOutcome, type SaveOutcome } from '../../../core/edit-save.ts';
import type { Outbox } from '../../../core/outbox-types.ts';
import { settingValue, type SettingRow, type SettingWriter } from '../../../core/setting-write.ts';
import { collection, readonlyIds } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { errName } from '../../../platform/env.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { categoryRow, cycleKeepers, type Row } from './note-list.ts';

export type { MergePair };

type Pair = Pick<MergePair, 'keep' | 'merge'>;
const tag = (p: Pair): string => `merge=${p.merge} keep=${p.keep}`;
const threw = (err: unknown): string => `threw ${errName(err) || 'unknown'}`;

/** 现在该提示的几对：活着的分类里 AI 判的和本机规则判的，且没点过“不用” */
export function openMergePairs(categories: readonly Row[], settings: readonly SettingRow[]): MergePair[] {
  return openPairs(categories.map(categoryRow), idPairs(settingValue(settings, MERGE_SUGGEST_KEY)), idPairs(settingValue(settings, MERGE_DISMISSED_KEY)));
}

/**
 * 记下“这一对不用再提示”（点了“不用”、撤销了合并）：在排到时的最新值上加（连点几对都记下），顺带去掉分类已经不活着的对。
 * 不往外抛：没写进本机、抛错都回 false，运行日志记 notes merge dismiss ok|fail merge= keep=
 */
export async function dismissMerge(writer: Pick<SettingWriter, 'update'>, pair: Pair, categories: readonly Row[]): Promise<boolean> {
  const live = new Set(categories.filter(isLiveCategory).map((c) => c.id));
  let ok = false;
  try {
    ok = await writer.update(MERGE_DISMISSED_KEY, (cur) => withPairs(idPairs(cur).filter(([a, b]) => live.has(a) && live.has(b)), [[pair.keep, pair.merge]]));
  } catch {
    ok = false;
  }
  rlog(`notes merge dismiss ${ok ? 'ok' : 'fail'} ${tag(pair)}`);
  return ok;
}

export interface MergeDeps {
  w?: Pick<typeof write, 'patch'>;
  isReadonly?: (categoryId: string) => boolean;
  /** 分类的最新快照（默认本机集合，调用时现读：提示条画出来以后分类可能又变了） */
  categories?: () => readonly Row[];
  /** 撤销合并时查、丢合并那一笔（默认 boot 的 outbox；没登录为 null） */
  outbox?: Pick<Outbox, 'list' | 'discardUnlessInflight'> | null;
}

const categoryReadonly = (id: string): boolean => readonlyIds('categories').getSnapshot().has(id);
const categorySnapshot = (): readonly Row[] => collection<Row>('categories').getSnapshot();

/** threw：写入口抛了异常（已记错误名，界面按出错条） */
export type MergeResult = { ok: true } | { ok: false; reason: Exclude<SaveOutcome, 'saved'> | 'gone' | 'threw' };

/** MergeResult → 列表页的 ActionResult：这一对已经没了不提示，抛异常按出错条，其余照 core 的 actionResult */
export const mergeAction = (r: MergeResult): ActionResult =>
  r.ok ? 'ok' : r.reason === 'gone' ? 'silent' : r.reason === 'threw' ? 'failed' : actionResult(r.reason);

/** 把 merge 合并进 keep：两个都要活着（keep 已经合进别处的不合，免得绕成圈）、不是同一个；只写 merge 一笔 {merged_into: keep} */
export async function mergeCategories(pair: MergePair, deps: MergeDeps = {}): Promise<MergeResult> {
  const { w = write, isReadonly = categoryReadonly, categories = categorySnapshot } = deps;
  const done = (code: string, r: MergeResult): MergeResult => {
    rlog(`notes merge category ${code} ${tag(pair)} why=${pair.why === 'ai' ? 'ai' : 'rule'}`);
    return r;
  };
  const fail = (reason: Exclude<MergeResult, { ok: true }>['reason']): MergeResult => done(reason, { ok: false, reason });
  try {
    const byId = new Map(categories().map((c) => [c.id, c]));
    const live = (id: string): boolean => {
      const c = byId.get(id);
      return c !== undefined && isLiveCategory(c);
    };
    if (pair.keep === pair.merge || !live(pair.keep) || !live(pair.merge)) return fail('gone');
    if (isReadonly(pair.merge)) return fail('readonly');
    const r = await saveOutcome(() => w.patch('categories', pair.merge, { merged_into: pair.keep }));
    return r === 'saved' ? done('ok', { ok: true }) : fail(r);
  } catch (err) {
    return done(threw(err), { ok: false, reason: 'threw' });
  }
}

/** 分类写回 merged_into: null（又成了活着的分类）：成环写回、撤销合并共用这一笔 */
const unmerge = (w: Pick<typeof write, 'patch'>, id: string): Promise<SaveOutcome> => saveOutcome(() => w.patch('categories', id, { merged_into: null }));

/** outbox 里合并那一笔、而且发送失败了：只有 merged_into: keep 一列（混进了别的改动的不算，丢了会连别的一起丢） */
const failedMerge = (i: { table: string; id: string; op: string; state: string; data: Record<string, unknown> }, pair: Pair): boolean =>
  i.table === 'categories' && i.id === pair.merge && i.op === 'patch' && i.state === 'failed' && Object.keys(i.data).join() === 'merged_into' && i.data['merged_into'] === pair.keep;

/**
 * 撤销刚才的合并（R-415 ③；顺序主持人 11-13 复查定）：
 * ① 只读行 → readonly，什么都不动；
 * ② outbox 里有发送失败的合并那一笔（被拒的 patch 本机已经显示回服务器那份）→ 丢掉它（免得以后“重试”又合并回去），不返回，接着往下：
 *    失败以后用户可能又点了一次“合并”，那一笔新的还在；
 * ③ 本机这个分类（丢完以后现读）还是 merged_into === keep → 写一笔 {merged_into: null}（还没发的合并那一笔，outbox 自己合成一笔）；
 *    没写成按失败返回，这时不记“不用”；
 * ④ 走到这里的（写成了、只丢了失败项、本机早就不指向 keep 了的 moved）都把这一对记进“不用”（负责人：撤销就当点了“不用”）；
 *    分类按撤销后的样子传，这个分类别的“不用”不会被当成不活着去掉。
 * 结果：写成了、只丢了失败项 ok；moved silent（不提示）。运行日志 notes merge undo <码> merge= keep=（ok / dropped / moved / 没写成的原因 /
 * threw <错误名>，抛异常也接住按 failed 回）
 */
export async function undoMerge(pair: Pair, writer: Pick<SettingWriter, 'update'>, deps: MergeDeps = {}): Promise<ActionResult> {
  const { w = write, isReadonly = categoryReadonly, categories = categorySnapshot, outbox = getBoot()?.outbox ?? null } = deps;
  const end = (code: string, r: ActionResult): ActionResult => {
    rlog(`notes merge undo ${code} ${tag(pair)}`);
    return r;
  };
  try {
    if (isReadonly(pair.merge)) return end('readonly', 'readonly');
    const failed = ((await outbox?.list()) ?? []).find((i) => failedMerge(i, pair));
    const dropped = failed !== undefined && (await outbox?.discardUnlessInflight(failed.op_id)) === true;
    const here = categories().find((c) => c.id === pair.merge)?.['merged_into'] === pair.keep;
    if (here) {
      const r = await unmerge(w, pair.merge);
      if (r !== 'saved') return end(r, actionResult(r));
    }
    await dismissMerge(writer, pair, categories().map((c) => (c.id === pair.merge ? { ...c, merged_into: null } : c)));
    return here ? end('ok', 'ok') : dropped ? end('dropped', 'ok') : end('moved', 'silent');
  } catch (err) {
    return end(threw(err), 'failed');
  }
}

/**
 * 本次运行里写回中、已写成的圈内分类 id：同一个只写成一次；没写成的拿掉，下次分类集合变化时再试（每次变化都会来查，不会快速连试）；
 * 写成了、之后不再是圈里留下的那个（圈已经解开）也拿掉：以后又绕成圈还能再写回
 */
const cycleFixed = new Set<string>();

/**
 * 两台设备各合并一次绕成圈（A → B、B → A）：给圈里留下的那个（note-list.ts 的 cycleKeepers）写一笔 merged_into: null（经 outbox），
 * 数据自己修好，之后全项目按 isLiveCategory 认它。只读行不写；运行日志只记 id 和结果（抛异常只记错误名）
 */
export async function fixCategoryCycles(categories: readonly Row[], deps: MergeDeps = {}): Promise<void> {
  const { w = write, isReadonly = categoryReadonly } = deps;
  const keepers = cycleKeepers(categories);
  for (const id of cycleFixed) if (!keepers.includes(id)) cycleFixed.delete(id);
  for (const id of keepers) {
    if (cycleFixed.has(id) || isReadonly(id)) continue;
    cycleFixed.add(id);
    let ok = false;
    try {
      ok = (await unmerge(w, id)) === 'saved';
      rlog(`notes category cycle fix id=${id} ${ok ? 'ok' : 'fail'}`);
    } catch (err) {
      rlog(`notes category cycle fix id=${id} ${threw(err)}`);
    } finally {
      if (!ok) cycleFixed.delete(id);
    }
  }
}
