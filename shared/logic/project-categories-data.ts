// AI 给日程、待办归的固定类别（R-440；-data.ts，A20 可写汉字、谚文）。只写这一处：
// 分色（project-color.ts 查表）、提示词（record.v4 / parse.v5 / voice.v5 经 fillPrompt 按界面语言填一套）、测试集 ① 判分（tests/ai/score-core.ts）都引它。
// 第 i 个固定用第 i+1 种项目色，中韩同义的同一个色（6 类正好 6 色，互不撞色）；最后一个“生活 / 생활”收出行、购物、缴费这类日常杂事。

export const PROJECT_CATEGORIES = Object.freeze({
  zh: Object.freeze(['工作', '学习', '健康', '家庭', '社交', '生活'] as const),
  ko: Object.freeze(['업무', '공부', '건강', '가족', '모임', '생활'] as const),
});
