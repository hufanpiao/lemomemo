// Vite 注入的环境变量：只允许 VITE_PUBLIC_ 开头的进前端（架构 8.1、A14）
interface ImportMetaEnv {
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly BASE_URL: string;
  readonly VITE_PUBLIC_ENV?: string;
  readonly VITE_PUBLIC_SUPABASE_URL?: string;
  readonly VITE_PUBLIC_ANON_KEY?: string;
  readonly VITE_PUBLIC_VAPID_KEY?: string;
  readonly VITE_PUBLIC_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** 开发服务器的热替换（构建产物里是 undefined，整段被摇掉）；只声明用到的 dispose */
  readonly hot?: { dispose(cb: () => void): void } | undefined;
}

/** CSS Modules：类名是字符串 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

/** 普通 CSS 只为副作用 import */
declare module '*.css';

/** 单独打包成同源文件、只要它的地址（AudioWorklet 的 addModule 用，platform/live-transcribe.ts） */
declare module '*?worker&url' {
  const url: string;
  export default url;
}

/** 版本号：构建时由 vite.config.ts 的 define 从 VERSION 文件注入（8.5） */
declare const __APP_VERSION__: string;
/** 构建时刻（ISO 字符串），只用于显示和日志 */
declare const __BUILD_TIME__: string;
/** 构建用的提交号前 7 位（vite.config.ts 的 buildCommit；别的打包方式可能没定义，读的时候先 typeof） */
declare const __BUILD_COMMIT__: string | undefined;
