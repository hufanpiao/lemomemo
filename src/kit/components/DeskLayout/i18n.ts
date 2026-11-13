// 电脑版布局（5.9b）的中韩词条：今天页、随手记页共用，跟着 DeskLayout 的懒加载块走，不进首屏。
// 放在这里而不是 features/today/i18n：随手记页也用（B6 代定，同 layout-model.ts）
import { makeUseT } from '../../hooks/useT.ts';

const zh = {
  'desk.handle': '移动“{name}”',
  'desk.handleHint': '空格拿起，方向键移动，空格放下，Esc 取消',
  'desk.collapse': '收起“{name}”',
  'desk.resize': '第 {n} 栏和第 {m} 栏的宽度',
  'desk.more': '布局',
  'desk.lock': '锁定布局',
  'desk.collapsed': '收起的块',
  'desk.collapsedNone': '没有收起的块',
  'desk.restore': '放回“{name}”',
  'desk.reset': '恢复默认布局',
  'desk.saved': '布局已保存',
  'desk.undo': '撤销',
  'desk.picked': '拿起了“{name}”，第 {c} 栏第 {n} 个',
  'desk.at': '“{name}”，第 {c} 栏第 {n} 个',
  'desk.dropped': '放下了“{name}”，第 {c} 栏第 {n} 个',
  'desk.cancelled': '已取消，“{name}”回到第 {c} 栏第 {n} 个',
  'desk.toLeft': '抽屉换到左边',
  'desk.toRight': '抽屉换到右边',
} as const;

const ko: Readonly<Record<keyof typeof zh, string>> = {
  'desk.handle': '“{name}” 옮기기',
  'desk.handleHint': '스페이스로 들고, 방향키로 옮기고, 스페이스로 놓기, Esc로 취소',
  'desk.collapse': '“{name}” 접기',
  'desk.resize': '{n}열과 {m}열의 너비',
  'desk.more': '레이아웃',
  'desk.lock': '레이아웃 잠그기',
  'desk.collapsed': '접어 둔 블록',
  'desk.collapsedNone': '접어 둔 블록이 없어요',
  'desk.restore': '“{name}” 다시 놓기',
  'desk.reset': '기본 레이아웃으로',
  'desk.saved': '레이아웃을 저장했어요',
  'desk.undo': '되돌리기',
  'desk.picked': '“{name}”을(를) 들었어요, {c}열 {n}번째',
  'desk.at': '“{name}”, {c}열 {n}번째',
  'desk.dropped': '“{name}”을(를) 놓았어요, {c}열 {n}번째',
  'desk.cancelled': '취소했어요, “{name}”은(는) {c}열 {n}번째로 돌아갔어요',
  'desk.toLeft': '서랍을 왼쪽으로',
  'desk.toRight': '서랍을 오른쪽으로',
};

export const deskDicts = { zh, ko };
export const useDeskT = makeUseT(deskDicts);
