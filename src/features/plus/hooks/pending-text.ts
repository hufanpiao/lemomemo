// 录音那一路先存的占位存进待办的两种标题（data/voice-pending.ts；数据层不准引词典，由这里查好交给控制器的 bind）
// 认不认得出是占位不看标题（判“用户动过没有”只看 saved-batch 的 look，和 AI 替换同一份）
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import type { PendText } from '../data/voice-pending.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

const ZH: PendText = { title: zh['plus.pending.title'], failed: zh['plus.pending.failedTitle'] };
const KO: PendText = { title: ko['plus.pending.title'], failed: ko['plus.pending.failedTitle'] };

export const pendText = (lang: Locale): PendText => (lang === 'ko-KR' ? KO : ZH);
