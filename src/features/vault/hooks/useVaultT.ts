// 功能 vault 的翻译钩子：词典见 ../i18n/zh.ts、ko.ts（翻译钩子统一由 kit/hooks/useT.ts 的 makeUseT 造）
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export const useVaultT = makeUseT({ zh, ko });
export type VaultKey = keyof typeof zh & string;
