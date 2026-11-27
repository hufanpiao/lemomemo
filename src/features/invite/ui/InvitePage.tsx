// 设置 › 邀请朋友（只有管理员看得到，R-83；架构 5.6 发码）：
// ① 备注（可以不写，≤ 40 字，只写编号或日期、不写名字——服务器判断不了，靠这里的说明写清楚）+ “生成邀请码”
// ② 刚生成的码：大字、4 位一组（K7Q2-M9XD-4TPA，同线框），一键复制（navigator.clipboard 不行就把码选中让人手动复制）；
//    写明“7 天内有效，只能用一次，这个码只显示这一次”
// ③ 发过的、还没过期的码：备注、用了没有、几号过期（服务器 list 不回码）；还没用的左滑露出红色“作废”（负责人 11-27，同待办左滑删除），
//    点了先弹 kit 的确认框（ConfirmDialog，同已登录设备的“移除”），确认了才作废；作废的那一行从列表里拿掉，下面写一句“已作废”
//    （不留着标“已作废”：库里没有作废标记这一列、不改表，作废就是把过期时刻改到从前，list 只列没过期的）
// 卡、行、按钮一律是 kit 的设置卡和 FormButton；本页样式只多三样（Invite.module.css）
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { enterCommits, FormButton } from '../../../kit/components/Form.tsx';
import form from '../../../kit/components/Form.module.css';
import refine from '../../../kit/components/Refine.module.css';
import { SettingsCard, SettingsDetailRow, SettingsInfoRow, SettingsRow, settingsErrorClass, settingsMetaClass } from '../../../kit/components/Settings/Settings.tsx';
import { rlog } from '../../../platform/run-log-api.ts';
import {
  groupInvite, INVITE_NOTE_MAX, noteLength, revocable, useInvite, usedUp, useWhen, type InviteErr, type InviteRow, type InviteState,
} from '../hooks/useInvite.ts';
import { useInviteT } from '../hooks/useInviteT.ts';
import styles from './Invite.module.css';

function useErrText(): (e: InviteErr) => string {
  const t = useInviteT();
  return (e) => {
    if (e === 'note_too_long') return t('inv.err.note_too_long', { max: INVITE_NOTE_MAX });
    return t(`inv.err.${e === 'bad_response' || e === 'not_found' ? 'failed' : e}`, {});
  };
}

/** 刚生成的码：只在这一页的内存里（离开这一页就没了） */
function FreshCard({ code, expiresAt }: { code: string; expiresAt: string }) {
  const t = useInviteT();
  const when = useWhen();
  const codeRef = useRef<HTMLSpanElement>(null);
  const [copy, setCopy] = useState<'' | 'ok' | 'failed'>('');
  const shown = groupInvite(code);
  /** 复制不了（没有 clipboard、没授权、不是安全上下文）就把码选中，让人长按或 Ctrl+C 复制 */
  const selectCode = (): void => {
    const el = codeRef.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const fail = (): void => {
    selectCode();
    setCopy('failed');
    rlog('invite copy err');
  };
  const onCopy = (): void => {
    try {
      void navigator.clipboard.writeText(shown).then(() => {
        setCopy('ok');
        rlog('invite copy ok');
      }, fail);
    } catch {
      fail();
    }
  };
  return (
    <SettingsCard title={t('inv.fresh.title', {})} showTitle note={t('inv.fresh.tip', { when: when(expiresAt) })} noteTestId="invite-fresh-tip" testId="invite-fresh">
      <SettingsRow>
        <span ref={codeRef} className={`${refine.num} ${styles.code}`} data-testid="invite-code">
          {shown}
        </span>
        <FormButton size="compact" strong onClick={onCopy} data-testid="invite-copy">
          {t('inv.copy', {})}
        </FormButton>
        <p className={copy === 'failed' ? settingsErrorClass : settingsMetaClass} role="status" data-testid="invite-copy-status">
          {copy === 'ok' ? t('inv.copied', {}) : copy === 'failed' ? t('inv.copyFailed', {}) : ''}
        </p>
      </SettingsRow>
    </SettingsCard>
  );
}

/** 作废没成的那一句：not_found 单说；断网、超时、服务器忙、登录过期用通用的几句；其余一律“没有作废成” */
type RevokeErrKey = 'inv.revoke.notFound' | 'inv.revoke.failed' | `inv.err.${'try_later' | 'timeout' | 'offline' | 'signed_out' | 'not_admin'}`;
function revokeErrKey(e: InviteErr): RevokeErrKey {
  switch (e) {
    case 'not_found':
      return 'inv.revoke.notFound';
    case 'try_later':
    case 'timeout':
    case 'offline':
    case 'signed_out':
    case 'not_admin':
      return `inv.err.${e}`;
    case 'note_too_long':
    case 'rate_limited':
    case 'bad_request':
    case 'bad_response':
    case 'failed':
      return 'inv.revoke.failed';
  }
}

function SentList({ s }: { s: InviteState }) {
  const t = useInviteT();
  const when = useWhen();
  const { list, revoking, revokeNotice } = s;
  const statusRef = useRef<HTMLParagraphElement>(null);
  const name = (r: InviteRow): string => r.note ?? t('inv.list.noNote', {});
  // 确认框关的时候有退场动画：标题接着用最后一次问的那一行，不在动画里变成空的
  const asked = useRef<InviteRow | null>(null);
  if (s.pending !== null) asked.current = s.pending;
  // 作废以后那一行没了（或确认框关了），焦点不能丢在页面开头：移到结果那一句（读屏接着念出来）
  useEffect(() => {
    if (revokeNotice !== null) statusRef.current?.focus();
  }, [revokeNotice]);
  // 不包外层 div：卡要和上面那块同级（kit 的 section:first-child 只给第一张卡的卡名上边 4，包一层就成了第一张）
  return (
    <>
      <SettingsCard title={t('inv.list.title', {})} showTitle testId="invite-list">
        {list.kind === 'loading' ? (
          <SettingsInfoRow label={t('inv.list.loading', {})} value="" testId="invite-list-loading" />
        ) : list.kind === 'error' ? (
          <SettingsInfoRow label={t('inv.list.failed', {})} value="" testId="invite-list-failed" alert />
        ) : list.rows.length === 0 ? (
          <SettingsInfoRow label={t('inv.list.empty', {})} value="" testId="invite-list-empty" />
        ) : (
          list.rows.map((r) => (
            <SettingsDetailRow
              key={r.id}
              label={name(r)}
              value={t(usedUp(r) ? 'inv.list.used' : 'inv.list.unused', {})}
              valueTestId="invite-row-used"
              // 还没用的才能左滑作废（同待办左滑删除，负责人 11-27“做成像删除一样，左滑作废”）；点红色“作废”后照旧弹确认框（不能撤回）。
              // 已用掉的作废也没意义，不能滑。作废进行中别的行不再给滑出来的按钮
              swipe={
                revocable(r) && revoking === null
                  ? { actions: [{ key: 'revoke', label: t('inv.revoke', {}), danger: true, onClick: () => s.askRevoke(r), testId: 'invite-revoke' }], log: rlog }
                  : undefined
              }
              metas={r.expires_at === null ? [] : [{ text: t('inv.list.expires', { when: when(r.expires_at) }), testId: 'invite-row-expires' }]}
              testId="invite-row"
            />
          ))
        )}
      </SettingsCard>
      <p
        ref={statusRef}
        tabIndex={-1}
        className={`${revokeNotice?.kind === 'err' ? settingsErrorClass : settingsMetaClass} ${styles.err}`}
        role="status"
        data-testid="invite-revoke-status"
      >
        {revokeNotice === null ? '' : revokeNotice.kind === 'done' ? t('inv.revoke.done', {}) : t(revokeErrKey(revokeNotice.err), {})}
      </p>
      <ConfirmDialog
        open={s.pending !== null}
        danger
        title={asked.current === null ? '' : t('inv.revoke.title', { name: name(asked.current) })}
        body={t('inv.revoke.body', {})}
        okLabel={t('inv.revoke.ok', {})}
        cancelLabel={t('inv.revoke.cancel', {})}
        testId="invite-revoke-confirm"
        onOk={s.confirmRevoke}
        onCancel={s.cancelRevoke}
      />
    </>
  );
}

export function InvitePage() {
  const t = useInviteT();
  const err = useErrText();
  const s = useInvite();
  const tipId = useId();
  const n = noteLength(s.note);
  const over = n > INVITE_NOTE_MAX;
  return (
    <div className={styles.page} data-testid="invite-page">
      <SettingsCard
        title={t('inv.note.title', {})}
        showTitle
        note={<span id={tipId}>{t('inv.note.tip', { max: INVITE_NOTE_MAX })}</span>}
        noteTestId="invite-note-tip"
      >
        <SettingsRow>
          <input
            className={`${form.input} ${styles.input}`}
            type="text"
            value={s.note}
            onChange={(e) => s.setNote(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (enterCommits(e)) s.create();
            }}
            placeholder={t('inv.note.placeholder', {})}
            aria-label={t('inv.note.title', {})}
            aria-describedby={tipId}
            aria-invalid={over || s.err === 'note_too_long' || undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={s.busy}
            data-testid="invite-note"
          />
          {n > 0 ? (
            <span className={over ? `${styles.count} ${styles.over}` : styles.count} aria-hidden="true" data-testid="invite-note-count">
              {t('inv.note.count', { n, max: INVITE_NOTE_MAX })}
            </span>
          ) : null}
        </SettingsRow>
      </SettingsCard>
      <div>
        <FormButton variant="primary" size="row" block onClick={s.create} disabled={s.busy} aria-busy={s.busy} data-testid="invite-create">
          {s.busy ? t('inv.creating', {}) : t('inv.create', {})}
        </FormButton>
        <p className={`${settingsErrorClass} ${styles.err}`} role="status" data-testid="invite-err">
          {s.err === null ? '' : err(s.err)}
        </p>
        {/* 刚生成的码出现时读屏念出来：外面这一层一直在（和按钮放在同一块里，空着时不多占一格间距） */}
        <div className={styles.live} aria-live="polite">
          {s.fresh === null ? null : <FreshCard key={s.fresh.code} code={s.fresh.code} expiresAt={s.fresh.expires_at} />}
        </div>
      </div>
      <SentList s={s} />
    </div>
  );
}
