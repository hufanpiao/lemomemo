// arch-fixture: expect=TS1360
// 违规：韩文词典少一个键编译不过（satisfies Record<SharedMsgKey, string>）
import type { SharedMsgKey } from '../../../shared/i18n/i18n.ts';

export const ko = {
  'app.name': '레모',
} as const satisfies Record<SharedMsgKey, string>;
