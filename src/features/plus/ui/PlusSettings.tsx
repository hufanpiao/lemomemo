// 设置 › 语音与 AI、在 Claude 聊天里记事（B3 FA-4；定稿线框 s13 的 R_AI、N_AI、R_CLA、N_CLA，视觉稿 PH.setai）
// plus/index.ts 只导出这一个懒加载组件（主持人 11-09 定方案 a：首屏只多一个导出，+32 B），part 区分哪一节，view 区分首页的值还是二级页正文：
// • view="value"：设置首页那一行右边的值（行名、整行、点了进二级页都由设置页画，同日历、提醒两行）；没读到之前空着
// • view="page"：二级页正文，只用 kit 的设置行；视觉稿里多出来的行（隐私记交给 AI、识图次数、按意思找次数、同意记录）以后各批再加
// 语音与 AI（R-369 照线框 s13 补齐）：麦克风（exe 不显示，R-90）、AI 整理开关、今天用量和进度条、恢复时刻（R-187）、说明（识别文案按设备分两套）
//   首页那一行的值：“AI 整理已打开 / 已关闭 · 今天 AI 用了 n 次 / 共 50 次”
// Claude（R-369：视觉稿里没有这一页，照线框 s13）：开关“在 Claude 聊天里记事”（服务器没有单独的开关，开着 = 有有效的连接码；
//   打开 = 生成连接码，明文只显示这一次、不做成链接、不存；关掉 = 断开连接）、连接码一行、“断开连接”一行普通字、说明
import { fmtDate } from '../../../../shared/i18n/fmt.ts';
import { SettingsCard, SettingsDetailRow, SettingsInfoRow, SettingsRow, SettingsSwitchRow } from '../../../kit/components/Settings/Settings.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { isAppleMobile } from '../../../platform/env.ts';
import { useAiOrganize, useAiUsage, useClaudeLink, useMicState, useShowTz, type ClaudeLink, type UsageView } from '../hooks/usePlusSettings.ts';
import { usePlusLine, usePlusT, type PlusMsgKey } from '../hooks/usePlusT.ts';
import styles from './TypeBar.module.css';

export type PlusSettingsPart = 'voiceAi' | 'claude';

type T = ReturnType<typeof usePlusT>;

/** 读不到用量时说明里写的每天上限（app_config.ai.per_user_daily 的默认值，架构 0.29 续“每天 50 次 AI 额度”）；读到了用服务器给的 */
const AI_DAILY_LIMIT = 50;

function usageText(u: UsageView, t: T): string {
  if (u.kind === 'loading') return '';
  if (u.kind === 'error') return t('plus.set.ai.failed', {});
  return t('plus.set.ai.used', { n: u.usage.used, limit: u.usage.limit });
}

function linkText(l: ClaudeLink['view'], t: T): string {
  if (l.kind === 'loading') return '';
  if (l.kind === 'error') return t('plus.set.cla.failed', {});
  return t(l.state.connected ? 'plus.set.cla.on' : 'plus.set.cla.off', {});
}

const MIC_KEY = { granted: 'plus.set.ai.micOn', denied: 'plus.set.ai.micOff', unknown: 'plus.set.ai.micUnknown' } as const;

function VoiceAiValue() {
  const t = usePlusT();
  const org = t(useAiOrganize().on ? 'plus.set.ai.orgOn' : 'plus.set.ai.orgOff', {});
  const used = usageText(useAiUsage(), t);
  return <>{used === '' ? org : `${org} · ${used}`}</>;
}

/** 今天用量的进度条（线框 s13）；读屏念“今天 AI 用量”和 n / limit */
function UsageMeter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  return (
    <span className={styles.meter} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}>
      <span className={styles.meterFill} style={{ width: `${pct}%` }} />
    </span>
  );
}

function VoiceAiPage() {
  const t = usePlusT();
  const usage = useAiUsage();
  const mic = useMicState();
  const org = useAiOrganize();
  const limit = usage.kind === 'ok' ? usage.usage.limit : AI_DAILY_LIMIT;
  return (
    <SettingsCard
      title={t('plus.set.ai.title', {})}
      testId="plus-set-ai"
      note={t(isAppleMobile() ? 'plus.set.ai.note' : 'plus.set.ai.noteWeb', { limit })}
      noteTestId="plus-set-ai-note"
    >
      {mic === null ? null : <SettingsInfoRow label={t('plus.set.ai.mic', {})} value={t(MIC_KEY[mic], {})} testId="plus-set-mic" valueTestId="plus-set-mic-value" />}
      <SettingsSwitchRow
        label={t('plus.set.ai.organize', {})}
        checked={org.on}
        onChange={org.set}
        error={org.failed ? t('plus.set.ai.orgFailed', {}) : undefined}
        testId="plus-set-ai-organize"
      />
      {usage.kind === 'ok' ? (
        <SettingsDetailRow
          label={usageText(usage, t)}
          metas={[
            { text: t('plus.set.ai.usedMeta', { time: usage.resetAt }), testId: 'plus-set-ai-reset' },
            { text: <UsageMeter used={usage.usage.used} limit={usage.usage.limit} label={t('plus.set.ai.usedLabel', {})} />, testId: 'plus-set-ai-meter' },
          ]}
          testId="plus-set-ai-used"
        />
      ) : (
        <SettingsInfoRow label={t('plus.set.ai.usedLabel', {})} value={usageText(usage, t)} testId="plus-set-ai-used" valueTestId="plus-set-ai-used-value" />
      )}
    </SettingsCard>
  );
}

function ClaudeValue() {
  const t = usePlusT();
  return <>{linkText(useClaudeLink().view, t)}</>;
}

const ERR_KEY: Record<Exclude<ClaudeLink['notice'], null | 'disconnected'>, PlusMsgKey> = {
  too_many: 'plus.set.cla.err.too_many',
  rate_limited: 'plus.set.cla.err.rate_limited',
  offline: 'plus.set.cla.err.offline',
  signed_out: 'plus.set.cla.err.signed_out',
  failed: 'plus.set.cla.err.failed',
};

function ClaudePage() {
  const t = usePlusT();
  const line = usePlusLine();
  const locale = useUi((s) => s.locale);
  const link = useClaudeLink();
  const tz = useShowTz();
  const v = link.view;
  const connected = v.kind === 'ok' && v.state.connected;
  const n = link.notice;
  const exp = link.code?.expiresAt ? Date.parse(link.code.expiresAt) : NaN;
  const made = v.kind === 'ok' ? v.state.madeMs : null;
  // 日期里的空格换成不换行空格：韩文“10월 24일”不在中间折行
  const info =
    connected && made !== null ? t('plus.set.cla.codeInfoDate', { date: fmtDate(made, tz, locale, 'monthDay').replace(/ /g, ' ') }) : t('plus.set.cla.codeInfo', {});
  // 开关：开着 = 有有效的连接码。打开 = 生成连接码；关掉 = 断开连接（同下面“断开连接”一行）。读不出来、正在处理时灰掉
  const onSwitch = (on: boolean): void => void (on ? link.create() : link.disconnect());
  return (
    <SettingsCard title={t('plus.set.cla.title', {})} testId="plus-set-cla" note={t('plus.set.cla.note', {})} noteTestId="plus-set-cla-note">
      <SettingsSwitchRow
        label={t('plus.set.cla.title', {})}
        checked={connected}
        onChange={onSwitch}
        disabled={v.kind !== 'ok' || link.busy !== null}
        note={v.kind === 'error' ? t('plus.set.cla.failed', {}) : n === 'disconnected' ? line('plus.set.cla.disconnected', {}) : undefined}
        error={n === null || n === 'disconnected' ? undefined : line(ERR_KEY[n], {})}
        testId="plus-set-cla-switch"
      />
      {link.code === null ? (
        // 线框 s13 左名右值：值在右边一栏里换行、不省略，不整块掉到行名下面（韩文一行放不下，kit 的 DetailRow 会整块换行）
        <SettingsRow testId="plus-set-cla-code-row">
          <span className={styles.codeLbl}>{t('plus.set.cla.code', {})}</span>
          <span className={styles.codeVal} data-testid="plus-set-cla-code-info">
            {info}
          </span>
        </SettingsRow>
      ) : (
        <SettingsDetailRow
          label={t('plus.set.cla.newCode', {})}
          metas={[
            // 明文码：纯文字、可以长按全选复制，不做成链接（R-65、S-B3 中 6）；只在这一次显示，离开这一页就没了
            { text: <span className={styles.code}>{link.code.token}</span>, testId: 'plus-set-cla-code' },
            ...(Number.isFinite(exp) ? [{ text: t('plus.set.cla.codeMeta', { date: fmtDate(exp, tz, locale, 'monthDay') }), testId: 'plus-set-cla-code-meta' }] : []),
          ]}
          testId="plus-set-cla-code-row"
        />
      )}
      {/* 断开连接：线框 s13 是一行普通字（不加粗、不带“›”）；没连着时灰掉 */}
      <SettingsRow testId="plus-set-cla-disconnect-row">
        <button
          type="button"
          className={styles.plainAct}
          onClick={() => void link.disconnect()}
          disabled={!connected || link.busy !== null}
          aria-busy={link.busy === 'disconnect'}
          data-testid="plus-set-cla-disconnect"
        >
          {t('plus.set.cla.disconnect', {})}
        </button>
      </SettingsRow>
    </SettingsCard>
  );
}

export default function PlusSettings({ part, view }: { part: PlusSettingsPart; view: 'value' | 'page' }) {
  if (part === 'voiceAi') return view === 'value' ? <VoiceAiValue /> : <VoiceAiPage />;
  return view === 'value' ? <ClaudeValue /> : <ClaudePage />;
}
