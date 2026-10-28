// ESLint 配置（架构 2.3：A1/A8/A27 分层、A2、A11、A12、A13、A18、A19、A22、A23、A24、A25、A26、T2、T3、W1）
// 每条规则在 tests/arch-fixtures/ 有违规样例，tests/arch/eslint.test.ts 逐个证明拦得住
// 写法：按目录分“作用域”，越往后越具体；no-restricted-* 每个作用域给全量选项（后面的块会整个覆盖前面的）
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import lemo from './build/eslint-rules/index.js';

const TS = ['**/*.ts', '**/*.tsx'];

// ───────── A1 / A8 / A27：分层（eslint-plugin-boundaries）─────────
// 元素按顺序匹配，先匹配先得；feature 捕获功能名，用来判断“同一个功能”
const elements = [
  { type: 'shared', pattern: 'shared' },
  { type: 'sw', pattern: 'src/sw' },
  { type: 'preview', pattern: 'src/preview-frame' },
  { type: 'platform-supabase', pattern: 'src/platform/supabase' },
  { type: 'platform', pattern: 'src/platform' },
  { type: 'core', pattern: 'src/core' },
  { type: 'feature-data', pattern: 'src/features/*/data', capture: ['feature'] },
  { type: 'feature-hooks', pattern: 'src/features/*/hooks', capture: ['feature'] },
  { type: 'feature-ui', pattern: 'src/features/*/ui', capture: ['feature'] },
  { type: 'feature-i18n', pattern: 'src/features/*/i18n', capture: ['feature'] },
  { type: 'feature-tests', pattern: 'src/features/*/__tests__', capture: ['feature'] },
  // 功能文件夹根上的文件：index.ts、data.manifest.ts、vault 的 plus-adapter.ts
  { type: 'feature', pattern: 'src/features/*', capture: ['feature'] },
  { type: 'kit-hooks', pattern: 'src/kit/hooks' },
  { type: 'kit', pattern: 'src/kit' },
  { type: 'motion', pattern: 'src/motion' },
  { type: 'styles', pattern: 'src/styles' },
  { type: 'app', pattern: 'src/app' },
];

const same = (type) => ({ element: { type, captured: { feature: '{{from.element.captured.feature}}' } } });
const any = (...types) => types.map((type) => ({ element: { type } }));
// app 里有两个文件下层也能用：build-info.ts（构建信息）和 router.ts（hrefOf、navigate）
const BUILD_INFO = { element: { type: 'app', fileInternalPath: 'build-info.ts' } };
const ROUTER = { element: { type: 'app', fileInternalPath: 'router.ts' } };
/** 别的功能：只能经它的 index.ts */
const otherFeatureIndex = { element: { type: 'feature', fileInternalPath: 'index.ts' } };

const layerPolicies = [
  { from: { element: { type: 'shared' } }, allow: { to: any('shared') } },
  { from: { element: { type: 'platform' } }, allow: { to: [...any('shared', 'platform', 'platform-supabase'), BUILD_INFO] } },
  { from: { element: { type: 'platform-supabase' } }, allow: { to: [...any('shared', 'platform', 'platform-supabase'), BUILD_INFO] } },
  { from: { element: { type: 'core' } }, allow: { to: [...any('shared', 'platform', 'platform-supabase', 'core'), BUILD_INFO] } },
  // 功能的 data：只认 shared、platform、core 和自己功能的 data；功能之间不能互相用 data
  {
    from: { element: { type: 'feature-data' } },
    allow: { to: [...any('shared', 'platform', 'platform-supabase', 'core'), BUILD_INFO, same('feature-data')] },
  },
  // 功能的 hooks：唯一能同时碰 React 和数据层的地方
  {
    from: { element: { type: 'feature-hooks' } },
    allow: {
      to: [
        ...any('shared', 'platform', 'platform-supabase', 'core', 'kit', 'kit-hooks', 'motion'), BUILD_INFO, ROUTER,
        same('feature-data'),
        same('feature-hooks'),
        same('feature-i18n'),
        otherFeatureIndex,
      ],
    },
  },
  // 功能的 ui：不碰 platform/supabase、core 和 data，数据经自己的 hooks
  {
    from: { element: { type: 'feature-ui' } },
    allow: {
      to: [
        ...any('shared', 'platform', 'kit', 'kit-hooks', 'motion'), BUILD_INFO, ROUTER,
        same('feature-hooks'),
        same('feature-ui'),
        same('feature-i18n'),
        otherFeatureIndex,
      ],
    },
  },
  { from: { element: { type: 'feature-i18n' } }, allow: { to: [...any('shared'), same('feature-i18n')] } },
  // 功能根上的文件（index.ts 等）：能引自己文件夹里的任何东西（index.ts 怎么引由 A27 管）
  {
    from: { element: { type: 'feature' } },
    allow: {
      to: [
        ...any('shared'),
        same('feature'),
        same('feature-data'),
        same('feature-hooks'),
        same('feature-ui'),
        same('feature-i18n'),
      ],
    },
  },
  {
    from: { element: { type: 'feature-tests' } },
    allow: {
      to: [
        ...any('shared', 'platform', 'platform-supabase', 'core', 'kit', 'kit-hooks', 'motion'), BUILD_INFO, ROUTER,
        same('feature'),
        same('feature-data'),
        same('feature-hooks'),
        same('feature-ui'),
        same('feature-i18n'),
      ],
    },
  },
  // kit 不认识任何功能；kit 的 hooks 才能碰 core
  { from: { element: { type: 'kit' } }, allow: { to: [...any('shared', 'kit', 'kit-hooks', 'motion'), BUILD_INFO, ROUTER] } },
  {
    from: { element: { type: 'kit-hooks' } },
    allow: { to: [...any('shared', 'platform', 'core', 'kit', 'kit-hooks'), BUILD_INFO] },
  },
  { from: { element: { type: 'motion' } }, allow: { to: any('shared', 'motion') } },
  {
    from: { element: { type: 'app' } },
    allow: {
      to: [
        ...any('shared', 'platform', 'core', 'kit', 'kit-hooks', 'motion', 'styles', 'app'), BUILD_INFO, ROUTER,
        otherFeatureIndex,
      ],
    },
  },
  // A19：sw 只认 shared 和自己（外部包另由 no-restricted-imports 限成 workbox-*）
  { from: { element: { type: 'sw' } }, allow: { to: any('shared', 'sw') } },
  { from: { element: { type: 'preview' } }, allow: { to: any('shared', 'preview', 'styles') } },
];

// ───────── 按目录拼 no-restricted-* ─────────
const NET_GLOBALS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'].map((name) => ({
  name,
  message: 'A12：网络请求只能写在 src/platform/',
}));
const DEVICE_GLOBALS = [
  'PushManager',
  'Notification',
  'MediaRecorder',
  'AudioContext',
  'webkitAudioContext',
  'SpeechRecognition',
  'webkitSpeechRecognition',
  'visualViewport',
].map((name) => ({ name, message: 'A13：设备和浏览器能力只能写在 src/platform/' }));
const RAF_GLOBALS = ['requestAnimationFrame', 'cancelAnimationFrame'].map((name) => ({
  name,
  message: 'A25：requestAnimationFrame 只能写在 src/motion/',
}));

const NET_SYNTAX = [
  {
    selector: "MemberExpression[property.name=/^(fetch|WebSocket|EventSource|XMLHttpRequest)$/][object.name=/^(window|self|globalThis)$/]",
    message: 'A12：网络请求只能写在 src/platform/',
  },
];
const DEVICE_SYNTAX = [
  {
    selector: 'MemberExpression[property.name=/^(credentials|serviceWorker|getUserMedia|mediaDevices|visualViewport|subtle)$/]',
    message: 'A13：navigator.credentials、serviceWorker、getUserMedia、visualViewport、crypto.subtle 只能写在 src/platform/',
  },
  {
    selector: "MemberExpression[property.name=/^(PushManager|Notification|MediaRecorder|AudioContext|SpeechRecognition|webkitSpeechRecognition)$/][object.name=/^(window|self|globalThis)$/]",
    message: 'A13：设备和浏览器能力只能写在 src/platform/',
  },
];
const HTML_SYNTAX = [
  { selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]', message: 'A22：禁止 innerHTML、outerHTML' },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'A22：禁止 insertAdjacentHTML' },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: 'A22：禁止 document.write',
  },
];
const MOTION_SYNTAX = [
  { selector: "CallExpression[callee.property.name='animate']", message: 'A25：element.animate 只能写在 src/motion/' },
  { selector: "MemberExpression[property.name='startViewTransition']", message: 'A25：startViewTransition 只能写在 src/motion/' },
  {
    selector: "MemberExpression[property.name=/^(requestAnimationFrame|cancelAnimationFrame)$/]",
    message: 'A25：requestAnimationFrame 只能写在 src/motion/',
  },
];
const PURE_SYNTAX = [
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'A2：shared 里不准 Date.now()，把 now 当参数传进来' },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'A2：shared 里不准无参 new Date()，把 now 当参数传进来' },
  { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'A2：shared 里不准 Math.random' },
];

const REACT_IMPORTS = {
  paths: ['react', 'react-dom', 'react-dom/client', 'zustand', 'react/jsx-runtime'].map((name) => ({
    name,
    message: 'A1：这一层不准 import React（只有 hooks 和 ui 能用）',
  })),
  patterns: [{ regex: '^(@radix-ui/|motion(/|$)|framer-motion)', message: 'A1：这一层不准 import 界面库' }],
};
const MOTION_IMPORTS = {
  paths: [],
  patterns: [{ regex: '^(motion|framer-motion)(/|$)', message: 'A25：Motion 只能在 src/motion/ 里 import' }],
};
const TAURI_IMPORTS = { paths: [], patterns: [{ regex: '^@tauri-apps/', message: 'A13：@tauri-apps/* 只能在 src/platform/ 里 import' }] };

function restrictedImports(...parts) {
  return [
    'error',
    { paths: parts.flatMap((p) => p.paths), patterns: parts.flatMap((p) => p.patterns) },
  ];
}

/** 一个作用域的三条 no-restricted-* 规则 */
function scope({ net = false, device = false, motion = false, html = false, pure = false, imports = [] }) {
  return {
    'no-restricted-globals': [
      'error',
      ...(net ? [] : NET_GLOBALS),
      ...(device ? [] : DEVICE_GLOBALS),
      ...(motion ? [] : RAF_GLOBALS),
    ],
    'no-restricted-syntax': [
      'error',
      ...(net ? [] : NET_SYNTAX),
      ...(device ? [] : DEVICE_SYNTAX),
      ...(html ? [] : HTML_SYNTAX),
      ...(motion ? [] : MOTION_SYNTAX),
      ...(pure ? PURE_SYNTAX : []),
    ],
    'no-restricted-imports': restrictedImports(...imports),
  };
}

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.wrangler/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'docs/**',
      'assets/**',
      'data/**',
      'desktop/**',
      'tests/arch-fixtures/**', // 违规样例：只在 tests/arch 里用虚拟路径过 ESLint
      'supabase/functions/_shared/gen/**',
      '.compat-base/**', // 旧版契约测试临时取出的基线用例（tests/compat/run-compat.ts）
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      // T2
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 3 },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // A22（与 HTML_SYNTAX 配合）
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // W1
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  // 构建脚本和配置文件：Node 环境
  {
    files: ['build/**/*.{js,mjs}', '*.config.{js,ts,mjs}', 'vite*.config.ts', 'playwright.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'max-lines': 'off' },
  },
  // ───────── 前端 src ─────────
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries, react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y, lemo },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: {
      react: { version: '19.3' },
      'boundaries/elements': elements,
      'boundaries/include': ['src/**/*', 'shared/**/*'],
      'boundaries/ignore': ['src/*.d.ts'],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.mjs'] } },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // T3
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/no-array-index-key': 'error',
      'react/prop-types': 'off',
      // A22
      'react/no-danger': 'error',
      // W1
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
      // A1 / A8 / A27
      'boundaries/dependencies': ['error', { default: 'disallow', policies: layerPolicies }],
      'boundaries/no-unknown-dependencies': 'error',
      'boundaries/no-unknown-files': 'error',
      'lemo/feature-index-exports': 'error',
      // A11、A24、A26
      'lemo/no-inline-color': 'error',
      'lemo/motion-tokens': 'error',
      'lemo/safe-href': 'error',
      ...scope({ imports: [MOTION_IMPORTS, TAURI_IMPORTS] }),
    },
  },
  // platform：网络和设备能力都在这里；不准 React
  {
    files: ['src/platform/**/*.{ts,tsx}'],
    rules: scope({ net: true, device: true, imports: [REACT_IMPORTS] }),
  },
  // core、功能的 data：纯 TS，不准 React
  {
    files: ['src/core/**/*.ts', 'src/features/*/data/**/*.ts', 'src/app/build-info.ts'],
    rules: scope({ imports: [REACT_IMPORTS, TAURI_IMPORTS] }),
  },
  // A18：隐私记的 data 不碰本机缓存、队列、日志
  {
    files: ['src/features/vault/data/**/*.ts'],
    rules: scope({
      imports: [
        REACT_IMPORTS,
        TAURI_IMPORTS,
        {
          paths: [],
          patterns: [
            {
              regex: '(^|/)core/(cache|outbox|log)(\\.ts)?$',
              message: 'A18：隐私记的明文不进本机缓存、离线队列和日志',
            },
          ],
        },
      ],
    }),
  },
  // motion：动效集中地
  {
    files: ['src/motion/**/*.{ts,tsx}'],
    rules: scope({ motion: true, imports: [TAURI_IMPORTS] }),
  },
  { files: ['src/motion/tokens.ts'], rules: { 'lemo/motion-tokens': 'off' } },
  // A19：sw 只能 import shared 和 workbox-*
  {
    files: ['src/sw/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker } },
    rules: scope({
      net: true,
      imports: [
        {
          paths: [],
          patterns: [{ regex: '^(?!\\.|workbox-)', message: 'A19：sw 只能 import shared 和 workbox-*' }],
        },
      ],
    }),
  },
  // A22 的唯一例外：预览沙箱里第三方预览库要写 DOM（0.20）
  {
    files: ['src/preview-frame/**/*.{ts,tsx}'],
    rules: scope({ html: true, imports: [MOTION_IMPORTS, TAURI_IMPORTS] }),
  },
  // 测试文件里可以用网络、rAF 等全局（模拟用）
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { ...scope({ net: true, device: true, motion: true }), 'max-lines-per-function': 'off' },
  },
  // ───────── shared：前后端共用，纯 TS（A2）─────────
  {
    files: ['shared/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': elements,
      'boundaries/include': ['src/**/*', 'shared/**/*'],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.mjs'] } },
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: layerPolicies }],
      ...scope({ pure: true, imports: [REACT_IMPORTS, TAURI_IMPORTS] }),
    },
  },
  // ───────── A23：服务器函数（supabase/functions，后端写；规则在这里）─────────
  {
    files: ['supabase/functions/**/*.ts'],
    plugins: { lemo },
    languageOptions: { globals: { Deno: 'readonly', ...globals.worker } },
    rules: { 'lemo/no-log-request': 'error' },
  },
  {
    files: ['supabase/functions/vault*/**/*.ts', 'supabase/functions/ai-voice/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  // Pages Functions（前端 B 写）也不准打印请求
  {
    files: ['functions/**/*.ts', 'workers/**/*.ts'],
    plugins: { lemo },
    rules: { 'lemo/no-log-request': 'error' },
  },
  // 官网静态页的脚本（前端 B）：普通 <script>，浏览器环境（B0 集成补上，原先按 Node 模块报 document 未定义）
  {
    files: ['site/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  // 数据库测试的 Node 脚本（后端：离线 SQL 检查等）
  {
    files: ['supabase/tests/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // 测试
  {
    files: ['tests/**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: TS,
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
);
