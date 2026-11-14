// 随手记一张图的识别状态（B4b-2 识图；线框 sAIst）：读同步下来的 note_images 行和 AI 开关，给界面 view；
// “重新识别”调 file-check {action: retry_ai}（data/file-check-api.ts 的 retryAiCall）：服务器改回 pending 以后，
//   本机先按回来的状态显示（同步下来的行要等下一次拉取），行变了就以行为准；没连上出一行提示。
// 运行日志：att ai retry ok=1 status=<状态> / ok=0 kind=<失败类> code=<码>；att ai open（去打开设置 › 语音与 AI）。不记图片 id、描述
import { useCallback, useEffect, useState } from 'react';
import type { SettingRow } from '../../../core/setting-read.ts';
import { aiOnFor } from '../../../kit/hooks/ai-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { readSessionId } from '../../../platform/session.ts';
import { navigate } from '../../../app/router.ts';
import { retryAiCall } from '../data/file-check-api.ts';
import { imageAiView, type ImageAiView, type Row } from '../data/image-ai.ts';

export type { ImageAiView } from '../data/image-ai.ts';

export function useImageAi(id: string): { view: ImageAiView | null; busy: boolean; retryFailed: boolean; retry(): void; open(): void } {
  const rows = useCollection<Row>('note_images');
  const settings = useCollection<SettingRow & { id: string }>('settings');
  const row = rows.find((r) => r.id === id);
  const [over, setOver] = useState<{ status: unknown; for: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const status = row?.['ai_status'];
  // 行变了（下一次拉取带回新状态）就不再用本机先显示的那个
  useEffect(() => setOver((o) => (o && o.for !== status ? null : o)), [status]);
  const shown = row && over ? { ...row, ai_status: over.status, skip_reason: null } : row;
  const view = imageAiView(shown, aiOnFor(settings, readSessionId()));
  const retry = useCallback(() => {
    setBusy(true);
    setRetryFailed(false);
    void retryAiCall(id).then((r) => {
      setBusy(false);
      if (r.ok) {
        setOver({ status: r.ai_status, for: status });
        rlog(`att ai retry ok=1 status=${r.ai_status}`);
      } else {
        setRetryFailed(true);
        rlog(`att ai retry ok=0 kind=${r.kind} code=${r.code}`);
      }
    });
  }, [id, status]);
  const open = useCallback(() => {
    rlog('att ai open');
    void navigate('settings', 'ai');
  }, []);
  return { view, busy, retryFailed, retry, open };
}
