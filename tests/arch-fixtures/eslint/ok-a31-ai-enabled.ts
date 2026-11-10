// arch-fixture: path=src/features/onboarding/hooks/x.ts expect=none
// 对照组（A31 ③）：告知页（onboarding 下）可以写 true；关掉写字面量 false、写 ai.vault 关掉，哪里都行（这里一并放在 onboarding 下验不误报）
import { writeAiSwitch, writeAiSwitchSettled } from '../../../core/ai-settings.ts';
export async function ok(): Promise<void> {
  await writeAiSwitchSettled({ key: 'ai.enabled', value: true });
  await writeAiSwitch({ key: 'ai.enabled', value: false });
  await writeAiSwitch({ key: 'ai.vault', value: false });
}
