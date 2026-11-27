// 设置 › AI 服务商 › 某一家的密钥（管理员）：方向二没单独画这一页，照方向一的 截图_方向一_填密钥后四位 / 试一下中 / 没通 / 通了
// • 小标题是公司名（Gemini 谷歌、Claude Anthropic、OpenAI OpenAI、DeepSeek 深度求索；联网搜索的 Brave、Tavily 只有密钥一格、没有“这家没有”卡）；模型名、密钥两个输入框；说明“密钥只显示后四位……”
// • 试的结果卡；左“试一下”、右边方向一是“设为在用”，方向二改成“保存”：试通了才能点，点了调 admin_key；下面一句“‘试一下’通了才能保存。”
// • “这家没有：……”卡（TASK_SUPPORT 里 no 的项；没有就不画）、“长期记忆不受影响”卡
// • 保存成了：清掉贴的密钥、回到“····后四位”，按钮下写“存好了。”（稿子没画）；没成写一句原因
import type { KeyOwnerName } from '../../../../shared/schema/ai-provider.ts';
import { missingOf } from '../hooks/rules.ts';
import { useActs } from '../hooks/useActions.ts';
import { labelOf, useAipT, useTaskList } from '../hooks/useAipT.ts';
import { useKeyForm, type Saved } from '../hooks/useKeyForm.ts';
import { useAdmin } from '../hooks/useProvider.ts';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import { ErrLine, InfoCard, KeyFields, MemCard, TestCard, TestPair, useErrText } from './parts.tsx';
import styles from './AiProvider.module.css';
import { useState } from 'react';

function KeyBody({ p, saved }: { p: KeyOwnerName; saved: Saved }) {
  const t = useAipT();
  const list = useTaskList();
  const err = useErrText();
  const form = useKeyForm('admin', p, saved);
  const acts = useActs();
  const [done, setDone] = useState(false);
  const lacks = missingOf(p);
  const save = async (): Promise<void> => {
    setDone(false);
    const out = await acts.adminKey(form.req());
    if (out.kind === 'done') {
      form.settle();
      setDone(true);
    }
  };
  const last = acts.last;
  const failText = last === null ? null : last.kind === 'err' ? err(last.err) : t('aip.t.fail', { why: t(`aip.why.${last.code}`, {}) });
  return (
    <div className={styles.stack} data-testid="aip-keypage" data-provider={p}>
      <section>
        <h2 className={groupLabelClass}>{t(`aip.co.${p}`, {})}</h2>
        <KeyFields form={form} last4={saved.last4} />
      </section>
      <p className={styles.note}>{t('aip.k.note', {})}</p>
      <TestCard test={form.test} p={p} own={false} />
      <TestPair form={form} mainLabel={t('aip.k.save', {})} onMain={() => void save()} mainBusy={acts.busy !== null} mainTestId="aip-save" />
      {form.passed ? null : <p className={styles.note}>{t('aip.k.hint', {})}</p>}
      {done && last === null ? (
        <p className={styles.note} role="status" data-testid="aip-saved">
          {t('aip.k.saved', {})}
        </p>
      ) : null}
      <ErrLine text={failText} testId="aip-save-err" />
      {lacks.length === 0 ? null : (
        <InfoCard title={t('aip.k.lacks', { p: labelOf(p), list: list(lacks, 'task') })} edge testId="aip-lacks">
          <p className={styles.cardBody}>{t('aip.k.lacksBody', { p: labelOf(p) })}</p>
        </InfoCard>
      )}
      <MemCard text={t('aip.mem.key', {})} />
    </div>
  );
}

export function AdminKeyPage({ provider }: { provider: KeyOwnerName }) {
  const t = useAipT();
  const admin = useAdmin();
  if (admin.kind === 'loading') return null;
  if (admin.kind === 'error') {
    return (
      <p className={styles.err} role="status" data-testid="aip-admin-failed">
        {t('aip.err.load', {})}
      </p>
    );
  }
  const k = admin.value.keys[provider];
  return <KeyBody p={provider} saved={{ model: k.model, last4: k.last4, has: k.has_key }} />;
}
