// vitest 全部项目的公共准备（vitest.config.ts 的 setupFiles）：公共词典默认只放中文一份（首屏瘦身 D，11-17；独立评审 11-17 第 3 条）。
// 网页里按语言懒加载、入口第一次画东西前先等（src/platform/doc-locale.ts），所以默认只有一份才和网页一样：
// 韩文那份没下载时 sharedT 退到中文、两份都没有退到启动兜底，这些路径默认就测得到。
// 要测韩文界面的用例自己 provideSharedDict('ko-KR', ko)（就像网页切到韩文时下载好那一份）；
// 只有韩文、两份都没有、下载失败几种见 src/platform/__tests__/shared-dict-load.test.ts
import { provideSharedDict } from '../../shared/i18n/i18n.ts';
import { zh } from '../../shared/i18n/zh.ts';

provideSharedDict('zh-CN', zh);
