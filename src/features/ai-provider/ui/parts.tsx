// 两页共用的几块：说明卡、单选的两行行、试的结果卡、填模型名和密钥的卡、左右两颗按钮、一句出错话
// 单选行的底子用 kit 设置行的样式（Settings.module.css 的 .choice、.check、.srOnly：44 高、分隔线、选中的右边“✓”），只多一行小字
import type { ReactNode } from 'react';
import type { KeyOwnerName, TestFailCode } from '../../../../shared/schema/ai-provider.ts';
import kit from '../../../kit/components/Settings/Settings.module.css';
import { Pressable } from '../../../motion/components.ts';
import { otherFails, secOf, type ProvErr } from '../hooks/rules.ts';
import { labelOf, useAipT } from '../hooks/useAipT.ts';
import type { KeyForm, TestView } from '../hooks/useKeyForm.ts';
import styles from './AiProvider.module.css';

/** 粗标题 + 灰字的说明卡；edge：左边一道柠檬黄 */
export function InfoCard({ title, children, edge, testId }: { title: ReactNode; children: ReactNode; edge?: boolean; testId?: string }) {
  return (
    <section className={edge === true ? `${styles.card} ${styles.edge}` : styles.card} data-testid={testId}>
      <h2 className={styles.cardTitle}>{title}</h2>
      {children}
    </section>
  );
}

export function MemCard({ text }: { text: string }) {
  const t = useAipT();
  return (
    <InfoCard title={t('aip.mem.title', {})} testId="aip-mem">
      <p className={styles.cardBody}>{text}</p>
    </InfoCard>
  );
}

/** 单选的一行：行名 + 下面一行小字 + 右边“✓”；off 时变淡、点不了；multi 是多选（勾选框，样子一样，联网搜索那一行用） */
export function ChoiceRow({ name, value, on, off, title, sub, onPick, testId, multi }: {
  name: string; value: string; on: boolean; off?: boolean; title: string; sub: string; onPick(): void; testId: string; multi?: boolean;
}) {
  // type 写成字面量（勾选框、单选框各一份）：input-font-size 守护按 type="…" 认非文字输入，写成表达式会被当成要 16px 的文字框；
  // 原生元素上不许展开属性（lemo/safe-href），两份照抄
  const none = (): void => undefined;
  return (
    <label className={off === true ? `${kit.choice} ${styles.off}` : kit.choice} data-on={on ? '1' : undefined} data-off={off === true ? '1' : undefined}>
      {multi === true ? (
        <input type="checkbox" className={kit.srOnly} name={name} value={value} checked={on} disabled={off} onChange={none} onClick={onPick} data-testid={testId} />
      ) : (
        <input type="radio" className={kit.srOnly} name={name} value={value} checked={on} disabled={off} onChange={none} onClick={onPick} data-testid={testId} />
      )}
      <span className={styles.two}>
        <span>{title}</span>
        <span className={styles.sub}>{sub}</span>
      </span>
      <span className={kit.check} aria-hidden="true">
        {on ? '✓' : ''}
      </span>
    </label>
  );
}

/** 一句出错话 */
export function useErrText(): (err: ProvErr) => string {
  const t = useAipT();
  return (err) => t(`aip.err.${err === 'bad_response' ? 'failed' : err}`, {});
}

export function ErrLine({ text, testId }: { text: string | null; testId: string }) {
  return text === null ? null : (
    <p className={styles.err} role="status" data-testid={testId}>
      {text}
    </p>
  );
}

/** 没通的卡：标题“没通：原因”、正文、最后一行列其他几种原因 */
function FailCard({ p, code, status }: { p: KeyOwnerName; code: TestFailCode; status: number | null }) {
  const t = useAipT();
  const name = labelOf(p);
  return (
    <section className={`${styles.card} ${styles.fail}`} data-testid="aip-test-fail" data-code={code}>
      <h2 className={styles.cardTitle}>{t('aip.t.fail', { why: t(`aip.why.${code}`, {}) })}</h2>
      <p className={styles.cardBody}>{code === 'auth' && status !== null ? t('aip.whyBody.authCode', { p: name, status }) : t(`aip.whyBody.${code}`, { p: name })}</p>
      <p className={styles.cardMeta}>{t('aip.t.others', { list: otherFails(code).map((c) => t(`aip.why.${c}`, {})).join(t('aip.dot', {})) })}</p>
    </section>
  );
}

/** 试的结果卡（没试过不画）；own：我的 AI 的写法（“试过了，通了”，不写“不算次数”） */
export function TestCard({ test, p, own }: { test: TestView; p: KeyOwnerName; own: boolean }) {
  const t = useAipT();
  const err = useErrText();
  if (test.kind === 'idle') return null;
  if (test.kind === 'busy') {
    return (
      <section className={styles.card} role="status" data-testid="aip-test-busy">
        <p className={styles.cardBody}>{t('aip.t.line', {})}</p>
      </section>
    );
  }
  if (test.kind === 'fail') return <FailCard p={p} code={test.code} status={test.status} />;
  if (test.kind === 'err') {
    return (
      <section className={`${styles.card} ${styles.fail}`} role="status" data-testid="aip-test-err">
        <p className={styles.cardBody}>{err(test.err)}</p>
      </section>
    );
  }
  return (
    <section className={`${styles.card} ${styles.pass}`} role="status" data-testid="aip-test-ok">
      <h2 className={styles.cardTitle}>{t(own ? 'aip.t.okOwn' : 'aip.t.ok', {})}</h2>
      <p className={styles.cardBody}>{t(own ? 'aip.t.okOwnBody' : 'aip.t.okBody', { p: labelOf(p), s: secOf(test.ms) })}</p>
    </section>
  );
}

/**
 * 密钥输入：已经有一把、没点“重贴”时是“••••后四位 重贴”（只配了环境变量、没有后四位的只画点）；贴新的时是密码框（不让浏览器记、不拼写检查、不自动大写）
 * 模型名输入框画在上面（两页都有；我的 AI 的模型名框也保留）。不预填任何默认模型名：只显示服务器上存着的。
 * 联网搜索的 Brave、Tavily 没有模型名（form.withModel 为 false），只画密钥一格
 */
export function KeyFields({ form, last4 }: { form: KeyForm; last4: string | null }) {
  const t = useAipT();
  return (
    <div className={styles.fields}>
      {form.withModel ? <label className={styles.field}>
        <span className={styles.fieldName}>{t('aip.k.model', {})}</span>
        <input
          className={styles.inp}
          type="text"
          value={form.model}
          onChange={(e) => form.setModel(e.currentTarget.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          data-testid="aip-model"
        />
      </label> : null}
      {form.pasting || !form.hasSaved ? (
        <label className={styles.field}>
          <span className={styles.fieldName}>{t('aip.k.key', {})}</span>
          <input
            className={styles.inp}
            type="password"
            value={form.key}
            onChange={(e) => form.setKey(e.currentTarget.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={300}
            data-testid="aip-key"
          />
        </label>
      ) : (
        <div className={styles.field}>
          <span className={styles.fieldName}>{t('aip.k.key', {})}</span>
          <div className={styles.inp}>
            <span className={styles.masked} data-testid="aip-key-masked">
              {last4 === null ? '•••••••••••••' : `••••••••••••• ${last4}`}
            </span>
            <button type="button" className={styles.repaste} onClick={form.repaste} data-testid="aip-repaste">
              {t('aip.k.repaste', {})}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 左“试一下”、右边主按钮（保存 / 改用这把密钥：试通了才能点） */
export function TestPair({ form, mainLabel, onMain, mainBusy, mainTestId }: { form: KeyForm; mainLabel: string; onMain(): void; mainBusy: boolean; mainTestId: string }) {
  const t = useAipT();
  const testing = form.test.kind === 'busy';
  return (
    <div className={styles.pair}>
      <Pressable className={styles.btn} onClick={() => void form.run()} disabled={!form.canTest || testing || mainBusy} aria-busy={testing} data-testid="aip-test">
        {testing ? t('aip.t.trying', {}) : t('aip.t.try', {})}
      </Pressable>
      <Pressable className={styles.btnMain} onClick={onMain} disabled={!form.passed || mainBusy} aria-busy={mainBusy} data-testid={mainTestId}>
        {mainLabel}
      </Pressable>
    </div>
  );
}
