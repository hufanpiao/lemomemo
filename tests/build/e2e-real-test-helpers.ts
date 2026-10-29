// tests/build/e2e-real-backend*.test.ts 共用的小工具（10-30 拆文件时从 e2e-real-backend.test.ts 挪来，行为不变）
import { PORT_TARGETS } from '../../tools/e2e/real-backend.mjs';

/** 最小的合格副本：只把端口表里必写的项写全，用来单独改一项看护栏（override 的值按原文写进去） */
export function minimal(projectId: string, override: Record<string, number | string> = {}): string {
  const bySection = new Map<string, string[]>();
  for (const t of PORT_TARGETS.filter((x) => x.required)) {
    const v = override[`${t.section}.${t.key}`] ?? t.value;
    bySection.set(t.section, [...(bySection.get(t.section) ?? []), `${t.key} = ${v}`]);
  }
  return [`project_id = "${projectId}"`, ...[...bySection].map(([s, ls]) => `[${s}]\n${ls.join('\n')}`)].join('\n');
}
