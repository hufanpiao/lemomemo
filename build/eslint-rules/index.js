// 柠檬记自己的 ESLint 规则（架构 2.3）。在 eslint.config.js 里以插件名 lemo 挂上
// 每条规则在 tests/arch-fixtures/ 有违规样例，tests/arch/eslint.test.ts 证明拦得住
import authEventsInSession from './auth-events-in-session.js';
import featureIndexExports from './feature-index-exports.js';
import motionTokens from './motion-tokens.js';
import noInlineColor from './no-inline-color.js';
import safeHref from './safe-href.js';
import noLogRequest from './no-log-request.js';
import settingsAiWrite from './settings-ai-write.js';

export default {
  meta: { name: 'eslint-plugin-lemo', version: '4.0.0' },
  rules: {
    'feature-index-exports': featureIndexExports,
    'motion-tokens': motionTokens,
    'no-inline-color': noInlineColor,
    'safe-href': safeHref,
    'no-log-request': noLogRequest,
    'auth-events-in-session': authEventsInSession,
    'settings-ai-write': settingsAiWrite,
  },
};
