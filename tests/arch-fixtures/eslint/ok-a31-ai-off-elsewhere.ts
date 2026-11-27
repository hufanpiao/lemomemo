// arch-fixture: path=src/features/plus/hooks/y.ts expect=none
// 对照组（A31 ③）：onboarding 以外关掉 ai.enabled（字面量 false）、关掉 ai.vault 不报
import { writeAiSwitch } from '../../../core/ai-settings.ts';
export async function ok(): Promise<void> {
  await writeAiSwitch({ key: 'ai.enabled', value: false });
  await writeAiSwitch({ key: 'ai.vault', value: false });
}
