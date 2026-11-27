// 正式的那一份录音控制器
// • mainVoice：放在这里（不在 useVoice.ts），好让结果层的“改成记下”（assist-open.ts 经 setAssistRecorder）、quick-add 都走它那一批（提示条、撤销同一套）
// • 判成别的意图的交给 assist-open.ts 的 toAssist（录音、quick-add 的日历日子是 null：控制器的上下文不带选中的那天）
// • quick-add：exe 的全局快速记录框交来的一句；控制器正忙（正在录、正在整理）、还没接上、出错时把原话留作草稿，下次点开“＋”填回，不丢
// • 运行日志：quick submit len=（只记字数）、quick record out=
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { releaseFxAudio, rewarmFxAudio, setFxMicBusy } from '../../../platform/fx-api.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { readSessionUserId } from '../../../platform/session.ts';
import { loadChatOpen } from '../../ai-chat/index.ts';
import { writeAssistDraft } from '../data/type-draft.ts';
import { createVoiceSession } from '../data/voice-session.ts';
import { setAssistRecorder, toAssist } from './assist-open.ts';
import { chatRecorderOf } from './chat-recorder.ts';

export const mainVoice = createVoiceSession({ onAsk: (ask, raw, aiUsed, from) => toAssist({ ask, raw, aiUsed, from: from === 'quick' ? 'quick' : 'voice', day: null }) });
// 结果层的“改成记下”走这一份控制器（assist-open.ts 不 import 这里，见那边的说明）
setAssistRecorder((raw, from, mode, day) => mainVoice.record(raw, from, mode, day));
// AI 助手回答里“要记成这样吗”卡片的拆和存（hooks/chat-recorder.ts）同样在这里登记：本机规则、保存口本来就在这一块，不改分包
// （放 TypeBarPreload 静态引或 import() 都会把打字条那一块拆成几个小块，“展开编辑”新建页晚到，e2e plus-expand-no-flash 红）
void loadChatOpen().then((m) => m.setChatRecorder(chatRecorderOf()));
// 录着（准备中、录音）时操作音效一律不出声、不碰 audioSession（platform/feedback.ts）
setFxMicBusy(() => mainVoice.view().capturing);
// 一开始收音就关掉操作音效的放音上下文（它平时只 suspend 不关，platform/feedback.ts scheduleIdle）；收完空闲时再建回来（不在下一下点按里建）
let wasCapturing = false;
mainVoice.subscribe(() => {
  const now = mainVoice.view().capturing;
  if (now && !wasCapturing) releaseFxAudio();
  if (!now && wasCapturing) rewarmFxAudio();
  wasCapturing = now;
});

/**
 * exe 的全局快速记录框（quick-add 窗口）交上来的一句（那个窗口不连服务器，只有 Rust 转发、没有自己的判断）：
 * main 页走打字条同一套 planText（本机规则有把握就不调 AI），记下的进这一批（提示条同录音），判成别的意图的打开结果层。
 * 整页只订阅一次，挂在 App 外壳上（app/plus-slot.tsx 下载好打字条那一块时调），不跟着 RecordHost 挂卸：
 * 设置页等页面、录音那一块出错被错误边界收掉时也照样取走。
 * 录音控制器还没接上上下文（RecordHost 从没挂上过）、正忙、没存上：原话留作草稿，下次点开“＋”填回，不丢。
 * 不是 exe、没登录不订阅；取的时候带这一页的账号（Rust 换了账号先清队列）。返回取消订阅
 */
export function listenQuickAdd(): () => void {
  const userId = isTauri() ? readSessionUserId() : null;
  if (!userId) return () => undefined;
  let off: (() => void) | null = null;
  let dead = false;
  const keep = (text: string): void => void writeAssistDraft({ text, day: null }, clock.now(), false);
  // desktop.ts 只有 exe 用得上：按需 import，不进录音这一块的静态依赖（首屏主包的预加载表少一项）
  void import('../../../platform/desktop.ts').then((m) => m.onQuickAddText((text) => {
    rlog(`quick submit len=${[...text].length}`);
    void mainVoice.record(text, 'quick', 'plan').then(
      (out) => {
        rlog(`quick record out=${out}`);
        if (out !== 'saved') keep(text);
      },
      () => {
        rlog('quick record out=error');
        keep(text);
      },
    );
  }, userId)).then(
    (f) => {
      if (dead) f();
      else off = f;
    },
    () => rlog('quick listen failed'),
  );
  return () => {
    dead = true;
    off?.();
  };
}
