// 设置 › 邀请朋友 读写的东西：数据层在 ../data/invite-api.ts
// • 进来读一次列表（list）；发了新码、作废了一个以后再读一次
// • 刚生成的码只放在这个组件的 state 里：离开这一页就没了（服务器也只回这一次），不写 localStorage、不写库
// • 防连点：发码、作废的请求没回来之前再点不发
// • 作废（负责人 11-27）：点“作废”先记下是哪一行（页面里的确认框问一次），确认了才发 revoke；成功就从列表里拿掉这一行再重读
// • 运行日志（rlog）只记动作名、结果码、条数和耗时，不记邀请码、不记备注、不记行的 id（A23）
import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtDate } from '../../../../shared/i18n/fmt.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import {
  createInvite, groupInvite, INVITE_NOTE_MAX, listInvites, noteLength, noteTooLong, revocable, revokeInvite, usedUp,
  type InviteErr, type InviteResult, type InviteRow, type NewInvite,
} from '../data/invite-api.ts';

export { groupInvite, INVITE_NOTE_MAX, noteLength, revocable, usedUp, type InviteErr, type InviteRow };

/** 列表的每一行都带服务器给的 id（同一份里不重复），直接当 React 的 key */
export type ListView = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; rows: InviteRow[] };
/** 上一次作废的结果：作废了 / 没作废成（not_found = 已用掉、已过期、已作废） */
export type RevokeNotice = { kind: 'done' } | { kind: 'err'; err: InviteErr } | null;

/** 某个时刻写成“12月4日 15:30”（按 current_tz，同设置 › 账号设备行的 fmtWhen） */
export function useWhen(): (iso: string) => string {
  const locale = useUi((s) => s.locale);
  const tz = currentTz();
  return (iso) => {
    const ms = Date.parse(iso);
    return `${fmtDate(ms, tz, locale, 'monthDay')} ${fmtDate(ms, tz, locale, 'time')}`;
  };
}

/** 结果记一行：“invite <动作> ok|err=码 [n=条数] ms=耗时” */
function logResult(action: string, r: InviteResult<unknown>, startedAt: number, n?: number): void {
  const count = n === undefined ? '' : ` n=${n}`;
  rlog(`invite ${action} ${r.ok ? 'ok' : `err=${r.err}`}${count} ms=${Math.round(clock.now() - startedAt)}`);
}

/**
 * 作废的这一行是不是刚生成、还显示在上面的那个码：create 不回 id，用过期时刻对（create 回的是毫秒精度的“现在 + 7 天”，
 * list 回 Postgres 的同一时刻；防连点保证同一页不会在同一毫秒发两个）。对上了就把上面那张卡收掉，免得还写着“7 天内有效”
 */
const isFresh = (row: InviteRow, fresh: NewInvite | null): boolean =>
  fresh !== null && row.expires_at !== null && Date.parse(row.expires_at) === Date.parse(fresh.expires_at);

export interface InviteState {
  list: ListView;
  note: string;
  setNote(v: string): void;
  busy: boolean;
  err: InviteErr | null;
  fresh: NewInvite | null;
  create(): void;
  /** 等确认作废的那一行（确认框开着） */
  pending: InviteRow | null;
  askRevoke(row: InviteRow): void;
  cancelRevoke(): void;
  confirmRevoke(): void;
  /** 正在作废的那一行的 id（请求没回来之前所有“作废”按钮灰掉） */
  revoking: string | null;
  revokeNotice: RevokeNotice;
}

export function useInvite(): InviteState {
  const [list, setList] = useState<ListView>({ kind: 'loading' });
  const [note, setNoteRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<InviteErr | null>(null);
  const [fresh, setFresh] = useState<NewInvite | null>(null);
  const [pending, setPending] = useState<InviteRow | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeNotice, setRevokeNotice] = useState<RevokeNotice>(null);
  const live = useRef(true);
  const inflight = useRef(false);
  const revokeInflight = useRef(false);

  const reload = useCallback(async (): Promise<void> => {
    const at = clock.now();
    const r = await listInvites();
    logResult('list', r, at, r.ok ? r.value.length : undefined);
    if (!live.current) return;
    // 重读失败时：已经读到过的留着，从没读到过才写“没读出来”
    if (r.ok) setList({ kind: 'ok', rows: r.value });
    else setList((v) => (v.kind === 'ok' ? v : { kind: 'error' }));
  }, []);

  useEffect(() => {
    live.current = true;
    void reload();
    return () => {
      live.current = false;
    };
  }, [reload]);

  const setNote = useCallback((v: string) => {
    setNoteRaw(v);
    // 改了备注，上一次“备注太长”“备注里有不能用的字符”就不对了
    setErr((e) => (e === 'note_too_long' || e === 'bad_request' ? null : e));
  }, []);

  const create = useCallback((): void => {
    if (inflight.current) return;
    if (noteTooLong(note)) {
      setErr('note_too_long');
      rlog('invite create err=note_too_long local=1');
      return;
    }
    inflight.current = true;
    setBusy(true);
    setErr(null);
    const at = clock.now();
    void createInvite(note)
      .then((r) => {
        logResult('create', r, at);
        if (!live.current) return;
        if (r.ok) {
          setFresh(r.value);
          setNoteRaw('');
          void reload();
        } else {
          setErr(r.err);
        }
      })
      .finally(() => {
        inflight.current = false;
        if (live.current) setBusy(false);
      });
  }, [note, reload]);

  const askRevoke = useCallback((row: InviteRow): void => {
    if (revokeInflight.current) return;
    setPending(row);
  }, []);
  const cancelRevoke = useCallback((): void => setPending(null), []);

  const confirmRevoke = useCallback((): void => {
    const row = pending;
    setPending(null);
    if (row === null || revokeInflight.current) return;
    revokeInflight.current = true;
    setRevoking(row.id);
    setRevokeNotice(null);
    const at = clock.now();
    void revokeInvite(row.id)
      .then((r) => {
        logResult('revoke', r, at);
        if (!live.current) return;
        if (r.ok) {
          // 服务器那边它已经等于过期：先从列表里拿掉（不等重读），刚生成的就是它的话上面那张卡也收掉
          setList((v) => (v.kind === 'ok' ? { kind: 'ok', rows: v.rows.filter((x) => x.id !== row.id) } : v));
          setFresh((f) => (isFresh(row, f) ? null : f));
          setRevokeNotice({ kind: 'done' });
        } else {
          setRevokeNotice({ kind: 'err', err: r.err });
        }
        // 成功、失败都重读一次：not_found（刚被用掉、刚过期）时列表也跟着变
        void reload();
      })
      .finally(() => {
        revokeInflight.current = false;
        if (live.current) setRevoking(null);
      });
  }, [pending, reload]);

  return { list, note, setNote, busy, err, fresh, create, pending, askRevoke, cancelRevoke, confirmRevoke, revoking, revokeNotice };
}
