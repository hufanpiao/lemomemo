// 本机规则分类的接口占位（B4 S5 归后端：shared/logic/notes/classify-rules.ts，纯函数，还没写；主持人 11-10：前端先占位，不自己写）
// • 新建随手记保存时调一次（note-edit.ts 的 newNoteRow 收它的结果）：分到了写 category_source = 'rule'，没分到写 'none'
// • 后端那份到了以后：这里改成 re-export / 转调它，签名以后端为准再对一次；调用方（useNoteList、useNoteEdit）不用改
// 纯 TS：不准 import React（A1）

export interface ClassifyInput {
  title: string;
  body: string;
}

export interface ClassifyCategory {
  id: string;
  name: string;
}

/** 给一条随手记算一个已有分类的 id；算不出来是 null。占位：一律 null（后端 classify-rules 到了再接） */
export function ruleCategory(_input: ClassifyInput, _categories: readonly ClassifyCategory[]): string | null {
  return null;
}
