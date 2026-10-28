// 入口（架构 2.2）：挂 React、加载样式、注册 SW
// StrictMode 只在开发版开（2.6）
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/skins/simple.css';
import '../styles/skins/glass.css';
import '../styles/base.css';
import { registerServiceWorker } from '../platform/sw-register.ts';
import { App } from './App.tsx';
import { buildInfo } from './build-info.ts';

const el = document.getElementById('root');
if (!el) throw new Error('root_missing');
el.dataset['version'] = buildInfo.version;

createRoot(el).render(
  import.meta.env.DEV ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : (
    <App />
  ),
);

if (!import.meta.env.DEV) void registerServiceWorker();
