// arch-fixture: path=src/features/plus/hooks/z.ts expect=lemo/settings-ai-write rule=A31 message=A31 count=3
// 违规（A31 ③，B3 FA-4 安全审复核建议 1）：改名导入、命名空间方括号调用都按 import 来源认；改名导入的函数当值传出去也报
import { writeAiSwitch as w } from '../../../core/ai-settings.ts';
import * as ai from '../../../core/ai-settings.ts';
export async function bad(): Promise<unknown> {
  await w({ key: 'ai.enabled', value: true });
  await ai['writeAiSwitchSettled']({ key: 'ai.enabled', value: true });
  const f = w;
  return f;
}
