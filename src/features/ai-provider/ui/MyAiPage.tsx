// 设置 › 我的 AI（人人都有）：截图_我的AI_默认、_自己的密钥、_切换前提示、_已用自己的、_删除密钥
// • “用哪个”两项：用柠檬记提供的 AI（今天用了 N / 50 次，几点清零）、用我自己的密钥（花你自己的钱，不占每天 50 次）
//   点“柠檬记的”：正在用自己的就调 own_off（密钥留着）；点“自己的”只是展开下面，不调服务器
// • 自己的密钥还没在用（或点了“换一家或重贴密钥”）：服务商四行单选、模型名和密钥（稿子没画模型名，契约要带）、试一下、“改用这把密钥”（试通才能点）
//   → 先出贴底提示“以后你的文字会发给 XX”：第一条写这家接管的几项（ownCovers），第二条写剩下的几项仍由柠檬记的 AI 做、占次数，第三条隐私记、第四条长期记忆
//   → “确定改用”调 own_use
// • 已用自己的：“我的密钥”一行（在用）、“换一家或重贴密钥 ›”、“谁做什么”卡、长期记忆卡、“删除密钥”（弹 kit 通用确认框问一次：不删 / 删除，删完回到柠檬记的 AI）
// • 页底“柠檬记现在用的是 XX（公司）。”（mine 的 project；只在用柠檬记的时候写，同稿子）
import { useState } from 'react';
import { AI_PROVIDERS, type AiProviderName, type MineRes } from '../../../../shared/schema/ai-provider.ts';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import { SettingsCard, SettingsDetailRow, SettingsEntryRow, SettingsIcon, SettingsList, settingsNoteClass } from '../../../kit/components/Settings/Settings.tsx';
import { Pressable } from '../../../motion/components.ts';
import { clockParts, ownSplit } from '../hooks/rules.ts';
import { useActs, type Acts } from '../hooks/useActions.ts';
import { labelOf, useAipT, useTaskList } from '../hooks/useAipT.ts';
import { useKeyForm } from '../hooks/useKeyForm.ts';
import { useMine, useUsage, type UsageView } from '../hooks/useProvider.ts';
import { ChoiceRow, ErrLine, InfoCard, KeyFields, MemCard, TestCard, TestPair, useErrText } from './parts.tsx';
import styles from './AiProvider.module.css';

/** 读不到用量时写的每天上限（同 plus 设置页的 AI_DAILY_LIMIT）；读到了用服务器给的 */
const AI_DAILY_LIMIT = 50;
const limitOf = (u: UsageView): number => (u.kind === 'ok' ? u.usage.limit : AI_DAILY_LIMIT);

/** 清零时刻“下午 5 点”“오후 5시”，不写“17:00”；不是整点时带分 */
function useClockText(): (hm: string) => string {
  const t = useAipT();
  return (hm) => {
    const { pm, h, m } = clockParts(hm);
    return m === 0 ? t(pm ? 'aip.clock.pm' : 'aip.clock.am', { h }) : t(pm ? 'aip.clock.pmMin' : 'aip.clock.amMin', { h, m });
  };
}

function useActErr(acts: Acts): string | null {
  const t = useAipT();
  const err = useErrText();
  const l = acts.last;
  return l === null ? null : l.kind === 'err' ? err(l.err) : t('aip.t.fail', { why: t(`aip.why.${l.code}`, {}) });
}

/** 切换前提示（截图_我的AI_切换前提示） */
function AskSheet({ p, open, limit, busy, onBack, onOk }: { p: AiProviderName; open: boolean; limit: number; busy: boolean; onBack(): void; onOk(): void }) {
  const t = useAipT();
  const list = useTaskList();
  const { covers, rest } = ownSplit(p);
  const name = labelOf(p);
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onBack())} edge title={t('aip.ask.title', { p: name })}>
      <section className={`${styles.card} ${styles.edge}`} data-testid="aip-ask">
        <ul className={styles.dots}>
          <li data-testid="aip-ask-covers">{t('aip.ask.covers', { what: list(covers, 'cover'), p: name })}</li>
          {rest.length === 0 ? null : <li data-testid="aip-ask-rest">{t('aip.ask.rest', { what: list(rest, 'rest'), limit })}</li>}
          <li>{t('aip.ask.vault', {})}</li>
          <li>{t('aip.ask.mem', {})}</li>
        </ul>
      </section>
      <div className={`${styles.pair} ${styles.pairIn}`}>
        <Pressable className={styles.btn} onClick={onBack} data-testid="aip-ask-back">
          {t('aip.ask.back', {})}
        </Pressable>
        <Pressable className={styles.btnMain} onClick={onOk} disabled={busy} aria-busy={busy} data-testid="aip-ask-ok">
          {t('aip.ask.ok', {})}
        </Pressable>
      </div>
    </Dialog>
  );
}

/** 选一家、贴密钥、试一下、改用 */
function OwnEdit({ own, limit, acts, onDone }: { own: MineRes['own']; limit: number; acts: Acts; onDone(): void }) {
  const t = useAipT();
  const [p, setP] = useState<AiProviderName | null>(own?.provider ?? null);
  return (
    <>
      <SettingsCard title={t('aip.my.prov', {})} showTitle radio testId="aip-own-prov">
        {AI_PROVIDERS.map((x) => (
          <ChoiceRow key={x} name="aip-own-prov" value={x} on={p === x} title={labelOf(x)} sub={t(`aip.co.${x}`, {})} onPick={() => setP(x)} testId={`aip-own-${x}`} />
        ))}
      </SettingsCard>
      {p === null ? null : <OwnKey key={p} p={p} own={own?.provider === p ? own : null} limit={limit} acts={acts} onDone={onDone} />}
    </>
  );
}

function OwnKey({ p, own, limit, acts, onDone }: { p: AiProviderName; own: MineRes['own']; limit: number; acts: Acts; onDone(): void }) {
  const t = useAipT();
  const form = useKeyForm('own', p, own === null ? null : { model: own.model, last4: own.last4, has: true });
  const [asking, setAsking] = useState(false);
  const errText = useActErr(acts);
  const use = async (): Promise<void> => {
    const out = await acts.ownUse(form.req());
    setAsking(false);
    if (out.kind === 'done') onDone();
  };
  return (
    <>
      <section>
        <h2 className={groupLabelClass}>{t('aip.my.key', {})}</h2>
        <KeyFields form={form} last4={own?.last4 ?? null} />
      </section>
      <p className={styles.note}>{t('aip.my.keyNote', {})}</p>
      <TestCard test={form.test} p={p} own />
      <TestPair form={form} mainLabel={t('aip.my.use', {})} onMain={() => setAsking(true)} mainBusy={acts.busy !== null} mainTestId="aip-use" />
      <ErrLine text={errText} testId="aip-use-err" />
      <AskSheet p={p} open={asking} limit={limit} busy={acts.busy !== null} onBack={() => setAsking(false)} onOk={() => void use()} />
    </>
  );
}

/** 已用自己的（截图_我的AI_已用自己的、_删除密钥） */
function OwnOn({ own, project, usage, acts, onChange }: { own: NonNullable<MineRes['own']>; project: AiProviderName | null; usage: UsageView; acts: Acts; onChange(): void }) {
  const t = useAipT();
  const list = useTaskList();
  const [asking, setAsking] = useState(false);
  const errText = useActErr(acts);
  const name = labelOf(own.provider);
  const { covers, rest } = ownSplit(own.provider);
  const lemo = labelOf(project ?? 'gemini');
  return (
    <>
      <section className={styles.mine}>
        <h2 className={groupLabelClass}>{t('aip.my.mine', {})}</h2>
        <SettingsList testId="aip-mine">
          <SettingsDetailRow
            lead={<SettingsIcon accent>{name.slice(0, 1)}</SettingsIcon>}
            label={name}
            metas={[{ text: t('aip.my.mineMeta', { l: own.last4 }), testId: 'aip-mine-meta' }]}
            value={<span className={styles.pill}>{t('aip.my.on', {})}</span>}
            testId="aip-mine-row"
          />
          <SettingsEntryRow label={t('aip.my.change', {})} onOpen={onChange} testId="aip-change" />
        </SettingsList>
        {own.fell_back === null ? null : (
          <p className={settingsNoteClass} role="status" data-testid="aip-fell-back">
            {t('aip.my.fellBack', { why: t(`aip.my.fellBack.${own.fell_back.why}`, {}), limit: limitOf(usage) })}
          </p>
        )}
      </section>
      <InfoCard title={t('aip.my.who', {})} testId="aip-who">
        <ul className={styles.dots}>
          <li>
            {t('aip.my.whoOwn', { tasks: list(covers, 'task'), p: name })}
            <span className={styles.ok}>{t('aip.my.free', {})}</span>
          </li>
          {rest.length === 0 ? null : (
            <li>
              {usage.kind === 'ok'
                ? t('aip.my.whoLemo', { tasks: list(rest, 'task'), p: lemo, n: usage.usage.used, limit: usage.usage.limit })
                : t('aip.my.whoLemoPlain', { tasks: list(rest, 'task'), p: lemo })}
            </li>
          )}
        </ul>
      </InfoCard>
      <MemCard text={t('aip.mem.own', { p: name })} />
      {/* 删除中“删除密钥”这一行灰掉、标忙（确认框点了删除就关，同其他用 ConfirmDialog 的地方） */}
      <SettingsList testId="aip-del-list">
        <SettingsEntryRow label={t('aip.my.del', {})} onOpen={() => setAsking(true)} disabled={acts.busy !== null} busy={acts.busy === 'own_delete'} center danger testId="aip-del" />
      </SettingsList>
      {/* 再问一次用 kit 的通用确认框；按钮 testid 是 aip-del-ask-cancel、aip-del-ask-ok */}
      <ConfirmDialog
        open={asking}
        danger
        title={t('aip.my.delTitle', {})}
        body={t('aip.my.delBody', { limit: limitOf(usage) })}
        okLabel={t('aip.my.delYes', {})}
        cancelLabel={t('aip.my.delNo', {})}
        testId="aip-del-ask"
        onOk={() => {
          setAsking(false);
          void acts.ownDelete();
        }}
        onCancel={() => setAsking(false)}
      />
      <ErrLine text={errText} testId="aip-del-err" />
      <p className={styles.note}>{t('aip.my.fallback', {})}</p>
    </>
  );
}

export function MyAiPage() {
  const t = useAipT();
  const clockText = useClockText();
  const mine = useMine(true);
  const usage = useUsage();
  const acts = useActs();
  /** 点了“用我自己的密钥”但还没改用（只展开下面）；点了“换一家或重贴密钥” */
  const [ownPicked, setOwnPicked] = useState(false);
  const [editing, setEditing] = useState(false);
  const errText = useActErr(acts);
  if (mine.kind === 'loading') return null;
  if (mine.kind === 'error') {
    return (
      <p className={styles.err} role="status" data-testid="aip-mine-failed">
        {t('aip.err.load', {})}
      </p>
    );
  }
  const { own, project } = mine.value;
  const active = own?.active === true;
  const ownMode = active || ownPicked;
  const limit = limitOf(usage);
  const pickLemo = (): void => {
    setEditing(false);
    setOwnPicked(false);
    if (active) void acts.ownOff();
  };
  const lemoSub =
    usage.kind === 'ok'
      ? usage.usage.unlimited
        ? t('aip.my.lemoFree', { n: usage.usage.used })
        : t('aip.my.lemoUsed', { n: usage.usage.used, limit: usage.usage.limit, time: clockText(usage.resetAt) })
      : '';
  return (
    <div className={styles.stack} data-testid="aip-my">
      <section>
        <SettingsCard title={t('aip.my.pick', {})} showTitle radio testId="aip-my-pick">
          <ChoiceRow name="aip-my" value="lemo" on={!ownMode} off={acts.busy !== null} title={t('aip.my.lemo', {})} sub={lemoSub} onPick={pickLemo} testId="aip-my-lemo" />
          <ChoiceRow name="aip-my" value="own" on={ownMode} off={acts.busy !== null} title={t('aip.my.own', {})} sub={t('aip.my.ownSub', { limit })} onPick={() => setOwnPicked(true)} testId="aip-my-own" />
        </SettingsCard>
        {ownMode || project === null ? null : (
          <p className={settingsNoteClass} data-testid="aip-my-project">
            {t('aip.my.project', { p: labelOf(project), co: t(`aip.co.${project}`, {}) })}
          </p>
        )}
      </section>
      {!ownMode ? (
        <>
          <ErrLine text={errText} testId="aip-off-err" />
          <MemCard text={t('aip.mem.mine', {})} />
        </>
      ) : active && !editing && own !== null ? (
        <OwnOn own={own} project={project} usage={usage} acts={acts} onChange={() => setEditing(true)} />
      ) : (
        // 改用成了：“点了自己的”这一下就用完了，以后按服务器的 active 算（不清的话删掉密钥后还停在填密钥那一步）
        <OwnEdit
          own={own}
          limit={limit}
          acts={acts}
          onDone={() => {
            setEditing(false);
            setOwnPicked(false);
          }}
        />
      )}
    </div>
  );
}
