// AI 记日程、待办时参考的“以前怎么分的”（R-497，负责人 11-28：“ai能有记忆，我每次保存日程和待办的时候自己分类好标签吗？”，弹窗选“学我以前怎么分的”）：
// 从本机的待办、日程里挑出分进自建项目的几条（标题 → 项目名），随 ai-parse 请求体 examples、ai-voice 请求头 X-Examples 交给 AI，
// 提示词（PARSE_RULES 的 {{HISTORY_RULE}}，有例子才有这条）让 AI 遇到同一类事时照写那个项目名。
// • 只收自建项目：固定类别（project-categories-data.ts 的 PROJECT_CATEGORIES，中韩两套）AI 本来就会选，不占名额；
//   库里没记“是谁定的分类”，固定类别的行多半是 AI 自己给的，拿来当例子只是把它自己的判断喂回去
//   （自建项目也可能是 AI 照原话里的项目名、或照这份例子给的，同样分不出；先这样，要分得等以后手动改分类时打标记）
// • 删掉的、撤销的不算；按最近改过的在前（updated_at 是毫秒数，shared/schema/rows.ts 的 epochMs；缺这一列的排最后），同一个标题只留最新一条
// • 每个项目最多 PER_PROJECT 条、一共最多 AI_EXAMPLES_MAX 条，标题截到 AI_EXAMPLE_TITLE_LEN 个字（上限是请求格式的，在 shared/schema/ai.ts）
// 纯函数。
import { AI_EXAMPLE_TITLE_LEN, AI_EXAMPLES_MAX, AI_PROJECT_LEN, type ProjectExample } from '../schema/ai.ts';
import { isLiveRow } from './live-row.ts';
import { PROJECT_CATEGORIES } from './project-categories-data.ts';

export const PER_PROJECT = 5;

type Row = Readonly<{ title?: unknown; project?: unknown; updated_at?: unknown } & Record<string, unknown>>;

const FIXED: ReadonlySet<string> = new Set<string>([...PROJECT_CATEGORIES.zh, ...PROJECT_CATEGORIES.ko]);

/** 是不是固定类别（中韩两套）；AI 助手卡片（src/features/plus/hooks/chat-recorder.ts）也用这一份 */
export const isFixedProject = (p: string): boolean => FIXED.has(p);

const cut = (s: string, n: number): string => [...s.trim()].slice(0, n).join('');

export function projectExamples(lists: readonly (readonly Row[])[]): ProjectExample[] {
  const rows: { title: string; project: string; at: number }[] = [];
  for (const list of lists) {
    for (const r of list) {
      if (!isLiveRow(r) || typeof r.project !== 'string' || typeof r.title !== 'string') continue;
      const project = cut(r.project, AI_PROJECT_LEN);
      const title = cut(r.title, AI_EXAMPLE_TITLE_LEN);
      if (project === '' || title === '' || isFixedProject(project)) continue;
      rows.push({ title, project, at: typeof r.updated_at === 'number' && Number.isFinite(r.updated_at) ? r.updated_at : -Infinity });
    }
  }
  rows.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));   // 两个 -Infinity 相减是 NaN，不用减法
  const out: ProjectExample[] = [];
  const seen = new Set<string>();
  const per = new Map<string, number>();
  for (const r of rows) {
    if (out.length >= AI_EXAMPLES_MAX) break;
    const n = per.get(r.project) ?? 0;
    if (seen.has(r.title) || n >= PER_PROJECT) continue;
    seen.add(r.title);
    per.set(r.project, n + 1);
    out.push({ title: r.title, project: r.project });
  }
  return out;
}
