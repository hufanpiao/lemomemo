// arch-fixture: path=src/features/settings/data/ai.ts expect=lemo/settings-ai-write rule=A31 message=A31 count=4
// 违规：功能代码对 settings 发软删、撤销；直接用 write.* 写 ai.enabled、ai.vault（应走 core/ai-settings.ts 的 writeAiSwitch）
import { write } from '../../../core/write.ts';
export async function bad(id: string): Promise<void> {
  await write.patch('settings', id, { deleted_at: 1 });
  await write['patch']('settings', id, { ...{ undone: true } });
  await write.insert('settings', { id, key: 'ai.enabled', value: true });
  await write.patch('settings', id, { key: `ai.vault`, value: false } as Record<string, unknown>);
}
