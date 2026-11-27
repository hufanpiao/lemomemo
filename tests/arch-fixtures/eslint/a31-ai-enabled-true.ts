// arch-fixture: path=src/features/plus/hooks/x.ts expect=lemo/settings-ai-write rule=A31 message=A31 count=3
// 违规（A31 ③，B3 FA-4 安全审第 4 条）：onboarding 以外把 ai.enabled 写成 true、值不是字面量 false、参数看不出键值
import { writeAiSwitch, writeAiSwitchSettled, type AiSwitch } from '../../../core/ai-settings.ts';
export async function bad(on: boolean, sw: AiSwitch): Promise<void> {
  await writeAiSwitch({ key: 'ai.enabled', value: true });
  await writeAiSwitchSettled({ key: 'ai.enabled', value: on });
  await writeAiSwitch(sw);
}
