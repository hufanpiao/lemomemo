// exe 快速记录小窗口的词条·韩文（见 quick-add-zh.ts）
import type { QuickAddMsgKey } from './quick-add-zh.ts';

export const quickAddKo = {
  label: '빠른 기록', // REVIEW(ko) exe 快速记录
  placeholder: '한 줄 쓰고 Enter를 누르세요', // REVIEW(ko) exe 快速记录
  hint: 'Enter 기록 · Esc 닫기', // REVIEW(ko) exe 快速记录
  failed: '전달하지 못했어요. 내용은 그대로 있으니 Enter를 다시 눌러 주세요', // REVIEW(ko) exe 快速记录
  full: '앞에서 보낸 내용이 아직 기록되지 않았어요. 레모 메인 창을 먼저 열어 주세요(로그인이 필요하면 로그인). 이 내용은 그대로 있어요', // REVIEW(ko) exe 快速记录
  tooLong: '너무 길어요. 한 번에 2000자까지 돼요. 조금 줄이고 Enter를 눌러 주세요', // REVIEW(ko) exe 快速记录
} satisfies Record<QuickAddMsgKey, string>;
