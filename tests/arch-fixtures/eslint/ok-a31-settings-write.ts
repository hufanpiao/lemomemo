// arch-fixture: path=src/features/settings/data/skin.ts expect=none
// 对照：settings 的普通键照常改值；别的表照常软删；core/ai-settings.ts 的 writeAiSwitch 照常用
import { writeAiSwitch } from '../../../core/ai-settings.ts';
import { write } from '../../../core/write.ts';
export async function ok(id: string): Promise<void> {
  await write.patch('settings', id, { value: 'glass' });
  await write.patch('todos', id, { deleted_at: 1 });
  await writeAiSwitch({ key: 'ai.enabled', value: false });
}
