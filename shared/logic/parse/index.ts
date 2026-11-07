// 本机规则（B 路）对外的入口（B3 任务单接口先定第 3 条）：parseSplit、confidence、recurHint、pastDate。
// 不进首屏：只准打字条那个按需加载的 chunk import（任务单 Q4）；服务器端经 _shared/gen/ 用（claude-intake 有 text 时本机规则优先）。
export { confidence, parseSplit, type Doubt, type ParseHints, type ParseOpts, type ParseResult } from './parse-split.ts';
export { recurHint } from './recur-hint.ts';
export { pastDate, resolveBasis, type Confirm, type DateBasis } from './past-date.ts';
export { arrangeHint } from './marks.ts';
