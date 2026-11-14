// AI 开着没有（B4b-2 整块评审第 9 条：“＋”打字录音 plus/hooks/useCaptureCtx.ts、查找 smart-search/hooks/useFind.ts 原来各写一份）：
// ai.enabled 为 true，且这次登录里同意版本没明确过期（kit/state/consent-fresh.ts）。会话 id 由调用方传（kit 不引 platform）。
// 纯 TS
import { settingValue, type SettingRow } from '../../core/setting-read.ts';
import { consentStale } from '../state/consent-fresh.ts';

export const aiOnFor = (settings: readonly SettingRow[], sid: string | null | undefined): boolean =>
  settingValue(settings, 'ai.enabled') === true && !consentStale(sid);
