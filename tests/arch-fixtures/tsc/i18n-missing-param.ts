// arch-fixture: expect=TS2345
// 违规：t() 的占位参数少传编译不过
import { t } from '../../../shared/i18n/i18n.ts';

export const s = t('fmt.monthDay', { m: 1 }, 'zh-CN');
