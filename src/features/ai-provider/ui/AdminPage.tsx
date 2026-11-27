// 设置 › AI 服务商（只有管理员；方案方向二）：截图_方向二_四项用途、截图_方向二_选一家
// • “每项用哪家”四行，右边写这项现在哪家做；下面一句“每项只列出有这本事、而且密钥试通了的几家。”
// • “密钥”七行（四家 + 联网搜索的 Brave、Tavily、Naver），右边“····后四位”或“没填”，点进这家的密钥详情（AdminKeyPage）
// • 底部“长期记忆不受影响”卡
// • 点用途行弹出贴底弹层“XX用哪家”：每家一行带小字状态，当前那家打勾；做不了的变灰点不了（没有这项 / 还没接上 / 还没填密钥）；
//   点了能选的一家 → admin_route → 成了关弹层、行值跟着重读的刷新；没成写一句原因，弹层不关
// • 换向量要重算的三张（换向量要重算 / 重算进度 / 算完）这次不做：向量那项除了 Gemini 都是 later，点不了，不出重算流程
// • 联网搜索（各家各自打勾，勾几家用几家）：“联网搜索”那一行的值写勾的几家
//   （“DeepSeek + Brave”），弹层标题“联网搜索方式”，列 DeepSeek / Brave / Naver / Tavily 四家，每家一个勾（多选，行的样子和单选一样）；
//   点一家就存（admin_web_route），弹层不关；只剩一个勾时那个点了没反应（同单选里点已选那项）；下面一句说明同时搜、退备用、至少勾一家。
//   “密钥”卡在四家下面多 Brave、Tavily、Naver 三行；弹层的样子不变（不动 kit Dialog）
import { useState } from 'react';
import { KEY_OWNERS, type AdminGetRes, type KeyOwnerName } from '../../../../shared/schema/ai-provider.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { SettingsCard, SettingsEntryRow, settingsNoteClass } from '../../../kit/components/Settings/Settings.tsx';
import { ADMIN_ROWS, isOn, isWebProvider, pickList, pickState, routeOf, routeWritable, toggleWeb, type AdminRow, type PickName } from '../hooks/rules.ts';
import { useActs } from '../hooks/useActions.ts';
import { labelOf, useAipT, webLabelOf } from '../hooks/useAipT.ts';
import { useAdmin } from '../hooks/useProvider.ts';
import { ChoiceRow, ErrLine, MemCard, useErrText } from './parts.tsx';
import styles from './AiProvider.module.css';

function PickSheet({ task, admin, onClose }: { task: AdminRow | null; admin: AdminGetRes; onClose(): void }) {
  const t = useAipT();
  const err = useErrText();
  const acts = useActs();
  const open = task !== null;
  const title = task === null ? '' : task === 'web' ? t('aip.ad.sheetWeb', {}) : t('aip.ad.sheet', { task: t(`aip.task.${task}`, {}) });
  // 联网那一行是多选：点一家就按新勾法存（admin_web_route），弹层不关，勾跟着重读的 admin_get 走；只剩一个勾时 toggleWeb 回 null，点了没反应
  const pick = async (tk: AdminRow, p: PickName): Promise<void> => {
    if (tk === 'web') {
      const next = isWebProvider(p) ? toggleWeb(admin.web, p) : null;
      if (next) await acts.adminWeb(next);
      return;
    }
    const out = await acts.adminRoute(tk, p);
    if (out.kind === 'done') onClose();
  };
  const last = acts.last;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          acts.clear();
          onClose();
        }
      }}
      edge
      lead={<span className={styles.grab} aria-hidden />}
      title={title}
    >
      {task !== null ? (
        <>
          <SettingsCard title={title} radio={task === 'web' ? 'checks' : true} testId="aip-pick">
            {pickList(task).map((p) => {
              const st = pickState(task, p, admin.keys);
              const cur = isOn(admin, task, p);
              const web = task === 'web';
              // 变灰勾不上：没密钥、做不了；联网里已经勾着的（后来密钥被删了）不灰，能取消
              const off = (st !== 'ok' && !(web && cur)) || !routeWritable(task) || acts.busy !== null;
              return (
                <ChoiceRow
                  key={p}
                  name={`aip-pick-${task}`}
                  value={p}
                  on={cur}
                  off={off}
                  multi={web}
                  title={labelOf(p)}
                  sub={t(`aip.ad.st.${st}`, {})}
                  onPick={() => {
                    if (!off && (web || !cur)) void pick(task, p);
                  }}
                  testId={`aip-pick-${p}`}
                />
              );
            })}
          </SettingsCard>
          {task === 'web' ? <p className={settingsNoteClass}>{t('aip.ad.webNote', {})}</p> : null}
          <p className={settingsNoteClass}>{t('aip.ad.sheetNote', {})}</p>
          <ErrLine text={last === null ? null : last.kind === 'err' ? err(last.err) : err('failed')} testId="aip-pick-err" />
        </>
      ) : null}
    </Dialog>
  );
}

export function AdminPage({ onOpenKey }: { onOpenKey(p: KeyOwnerName): void }) {
  const t = useAipT();
  const admin = useAdmin();
  const [task, setTask] = useState<AdminRow | null>(null);
  if (admin.kind === 'loading') return null;
  if (admin.kind === 'error') {
    return (
      <p className={styles.err} role="status" data-testid="aip-admin-failed">
        {t('aip.err.load', {})}
      </p>
    );
  }
  const { keys } = admin.value;
  return (
    <div className={styles.stack} data-testid="aip-admin">
      <SettingsCard title={t('aip.ad.routes', {})} showTitle note={t('aip.ad.routesNote', {})} testId="aip-routes">
        {ADMIN_ROWS.map((k) => (
          <SettingsEntryRow
            key={k}
            label={t(`aip.task.${k}`, {})}
            value={k === 'web' ? webLabelOf(admin.value.web) : labelOf(routeOf(admin.value, k))}
            onOpen={() => setTask(k)}
            testId={`aip-route-${k}`}
            valueTestId={`aip-route-${k}-value`}
          />
        ))}
      </SettingsCard>
      <SettingsCard title={t('aip.ad.keys', {})} showTitle testId="aip-keys">
        {KEY_OWNERS.map((p) => {
          const { last4: l4, has_key: has } = keys[p];
          return (
            <SettingsEntryRow
              key={p}
              label={labelOf(p)}
              value={!has ? t('aip.ad.noKey', {}) : l4 === null ? t('aip.ad.envKey', {}) : t('aip.ad.last4', { l: l4 })}
              onOpen={() => onOpenKey(p)}
              testId={`aip-key-${p}`}
              valueTestId={`aip-key-${p}-value`}
            />
          );
        })}
      </SettingsCard>
      <MemCard text={t('aip.mem.admin', {})} />
      <PickSheet task={task} admin={admin.value} onClose={() => setTask(null)} />
    </div>
  );
}
