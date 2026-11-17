// vitest 全部项目的公共准备（vitest.config.ts 的 setupFiles）：把中韩两份公共词典都放进 sharedT（首屏瘦身 D，11-17）。
// 网页里按语言懒加载、入口渲染前先等（src/platform/doc-locale.ts 的 loadSharedDict）；单测不走入口，两份一开始就放好，
// 组件、fmt 照旧同步拿到文字。只测懒加载本身的用例（src/platform/__tests__/shared-dict-load.test.ts）用 vi.resetModules 换一份空的
import { provideSharedDict } from '../../shared/i18n/i18n.ts';
import { ko } from '../../shared/i18n/ko.ts';
import { zh } from '../../shared/i18n/zh.ts';

provideSharedDict('zh-CN', zh);
provideSharedDict('ko-KR', ko);
