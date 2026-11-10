// arch-fixture: path=src/features/onboarding/hooks/v.ts expect=lemo/settings-ai-write rule=A31 message=A31 count=2
// 违规（A31 ③，B3 FA-4 安全审复核建议 2）：ai.vault 只能写字面量 false，onboarding 下也一样（打开只能经服务器 set_ai_vault）
import { writeAiSwitch, type AiSwitch } from '../../../core/ai-settings.ts';
export async function bad(on: boolean): Promise<void> {
  await writeAiSwitch({ key: 'ai.vault', value: true } as unknown as AiSwitch);
  await writeAiSwitch({ key: 'ai.vault', value: on } as unknown as AiSwitch);
}
