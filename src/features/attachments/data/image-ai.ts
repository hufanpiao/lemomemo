// 随手记一张图的识别状态 → 界面显示哪一种（B4b-2 识图；线框 sAIst、架构 5.13 第 5 点）。纯 TS：不准 import React（A1）
// 行是同步下来的 note_images（ai_status、skip_reason、ai_desc、ai_tags 由服务器 ai-media 写，客户端只读）：
// • done 且有描述 → seen（“AI 看到的”+ 描述 + 标签）
// • failed → failed（“没识别 · 试了 3 次没成功”+“重新识别”）
// • skip / consent，或还是 pending 但本机判断 AI 没开（ai.enabled 不是 true、同意版本过期）→ off（“没交给 AI”+“去打开”）：
//   服务器下一轮也会写成 skip / consent，本机先按没开显示，不让人干等“识别中”
// • pending → pending（“识别中”，不打扰）
// • skip / other（太大、打不开）→ other；skip / vault_off（隐私记）和别的 → 不显示
// 隐私记的图（vault-images）、删了的不显示

export type Row = { id: string } & Record<string, unknown>;

export type ImageAiView =
  | { kind: 'seen'; desc: string; tags: string[] }
  | { kind: 'pending' | 'failed' | 'off' | 'other' };

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

export function imageAiView(row: Row | undefined, aiOn: boolean): ImageAiView | null {
  if (!row || row['bucket'] !== 'images' || row['deleted_at'] != null) return null;
  const status = row['ai_status'];
  const reason = row['skip_reason'];
  if (status === 'done') {
    const desc = typeof row['ai_desc'] === 'string' ? row['ai_desc'] : '';
    return desc === '' ? null : { kind: 'seen', desc, tags: strs(row['ai_tags']) };
  }
  if (status === 'failed') return { kind: 'failed' };
  if (status === 'pending') return { kind: aiOn ? 'pending' : 'off' };
  if (status === 'skip' && reason === 'consent') return { kind: 'off' };
  if (status === 'skip' && reason === 'other') return { kind: 'other' };
  return null;
}
