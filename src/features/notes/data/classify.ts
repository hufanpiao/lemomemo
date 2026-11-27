// 随手记保存时的本机规则分类：转调后端的 shared/logic/notes/classify-rules.ts（前端保存时调用）。
// • 新建随手记保存时调一次（note-edit.ts 的 newNoteRow 收它的结果）：分到了写 category_source = 'rule'，没分到写 'none'
// • 只从用户已有的分类里选、不新建；删了的、撤销的、合并掉的分类由 classifyByRules 自己跳过
// 纯 TS：不准 import React
import { classifyByRules } from '../../../../shared/logic/notes/classify-rules.ts';

export interface ClassifyInput {
  title: string;
  body: string;
}

export interface ClassifyCategory {
  id: string;
  name: string;
}

/** 给一条随手记算一个已有分类的 id；算不出来是 null */
export function ruleCategory(input: ClassifyInput, categories: readonly ClassifyCategory[]): string | null {
  return classifyByRules(input, categories).category_id;
}
