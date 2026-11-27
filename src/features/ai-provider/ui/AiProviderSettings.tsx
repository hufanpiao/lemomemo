// 设置页里用到的几块（ai-provider/index.ts 只导出这一个懒加载组件，part 区分，见 index.ts 的说明）
// 入口（截图_入口_设置首页）：“我的 AI”在“常用”卡里“语音与 AI”下面（人人都有），值“柠檬记提供 · 12 / 50”，用自己的密钥时写“自己的密钥 · OpenAI”（稿子没写这一句）；
// “AI 服务商”在“更多”卡里“在 Claude 聊天里记事”下面，只在 mine 回 admin: true 时出现，值是对话和整理那项的服务商（mine 的 project）；
// “邀请朋友”（invite 功能）一行也只给管理员：设置页把整行包在 part="adminOnly" 里，判断和“AI 服务商”同一个（useAdminMine）
import type { ReactNode } from 'react';
import { SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import type { KeyOwnerName, MineRes } from '../../../../shared/schema/ai-provider.ts';
import { isKeyOwner } from '../hooks/rules.ts';
import { labelOf, useAipT } from '../hooks/useAipT.ts';
import { useMine, useUsage } from '../hooks/useProvider.ts';
import { AdminKeyPage } from './AdminKeyPage.tsx';
import { AdminPage } from './AdminPage.tsx';
import { MyAiPage } from './MyAiPage.tsx';

function MyAiValue() {
  const t = useAipT();
  const mine = useMine();
  const usage = useUsage();
  if (mine.kind === 'ok' && mine.value.own?.active === true) return <>{t('aip.row.own', { p: labelOf(mine.value.own.provider) })}</>;
  if (usage.kind !== 'ok') return <>{mine.kind === 'ok' ? t('aip.row.lemoPlain', {}) : null}</>;
  return <>{usage.usage.unlimited ? t('aip.row.lemoFree', {}) : t('aip.row.lemo', { n: usage.usage.used, limit: usage.usage.limit })}</>;
}

/** 是不是管理员只看这一处：mine 读到了、admin 为 true；不是管理员、还没读到、读不出来都回 null（首页“AI 服务商”“邀请朋友”两行共用） */
function useAdminMine(): MineRes | null {
  const mine = useMine();
  return mine.kind === 'ok' && mine.value.admin ? mine.value : null;
}

/** 只有管理员才画 children（首页“邀请朋友”一行：行由设置页画，这里只管画不画） */
function AdminOnly({ children }: { children: ReactNode }) {
  return useAdminMine() === null ? null : <>{children}</>;
}

/** 首页“AI 服务商”一行：值是对话和整理那项的服务商 */
function AdminRow({ label, onOpen }: { label: string; onOpen(): void }) {
  const mine = useAdminMine();
  if (mine === null) return null;
  const p = mine.project;
  return (
    <SettingsEntryRow
      rowId="aiProvider"
      label={label}
      value={p === null ? undefined : labelOf(p)}
      onOpen={onOpen}
      testId="settings-ai-provider-entry"
      valueTestId="settings-ai-provider-summary"
    />
  );
}

export type AiProviderSettingsProps =
  | { part: 'myAiValue' }
  | { part: 'adminRow'; label: string; onOpen(): void }
  | { part: 'adminOnly'; children: ReactNode }
  | { part: 'myAi' }
  | { part: 'admin'; onOpenKey(p: KeyOwnerName): void }
  | { part: 'adminKey'; provider: string | undefined };

export default function AiProviderSettings(props: AiProviderSettingsProps) {
  switch (props.part) {
    case 'myAiValue':
      return <MyAiValue />;
    case 'adminRow':
      return <AdminRow label={props.label} onOpen={props.onOpen} />;
    case 'adminOnly':
      return <AdminOnly>{props.children}</AdminOnly>;
    case 'myAi':
      return <MyAiPage />;
    case 'admin':
      return <AdminPage onOpenKey={props.onOpenKey} />;
    case 'adminKey':
      return isKeyOwner(props.provider) ? <AdminKeyPage provider={props.provider} /> : null;
  }
}
