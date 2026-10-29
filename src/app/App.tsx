// App 外壳：按 hash 路由挂页面（各页面懒加载，A27）
import { lazy, Suspense } from 'react';
import { getBoot } from '../core/boot.ts';
import { useT } from '../kit/hooks/useT.ts';
import { isProduction } from '../platform/env.ts';
import { reloadPage } from '../platform/sw-register.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { UpdateBanner } from './UpdateBanner.tsx';
import { featureRoutes, offRoutes, type FeatureRoute } from './features.ts';
import { useRoute } from './router.ts';

// CSP 试验页（B0 第一项验证）：只在非正式版里挂
const devRoutes: readonly FeatureRoute[] = isProduction
  ? []
  : [{ name: 'dev-csp', Page: lazy(() => import('./dev/CspLab.tsx')) }];

function ErrorView() {
  const t = useT();
  return (
    <p role="alert" data-testid="app-error">
      {t('error.unknown', {})}
    </p>
  );
}

/** 功能开关关着的页面（hash 直接打开时）：不是出错（K6 审查 L11） */
function FeatureOffView() {
  const t = useT();
  return (
    <p role="status" data-testid="feature-off">
      {t('feature.off', {})}
    </p>
  );
}

/** 顶部版本横幅（UpdateBanner.tsx）：还没启动（测试里）、本机库来自更新的版本（整屏提示管）时不画 */
function Banner() {
  const boot = getBoot();
  if (!boot) return null;
  return <UpdateBanner upgrade={boot.upgrade} outbox={boot.outbox} onReload={reloadPage} />;
}

export function App() {
  const route = useRoute();
  const hit = [...featureRoutes, ...devRoutes].find((r) => r.name === route.name);
  const Page = hit?.Page;
  // 横幅和页面放在同一个 Suspense 里：页面分包没到时一起不画，启动画面不会因为先画出横幅就提前收起（root.tsx 头注释）。
  // 横幅在页面的错误边界外面（架构师 10-30 第 6 点）：页面出错显示 ErrorView 时横幅还在；横幅自己出错只是不画横幅
  return (
    <Suspense fallback={null}>
      <ErrorBoundary fallback={null}>
        <Banner />
      </ErrorBoundary>
      <ErrorBoundary key={route.name} fallback={<ErrorView />}>
        {Page ? <Page /> : offRoutes.has(route.name) ? <FeatureOffView /> : <ErrorView />}
      </ErrorBoundary>
    </Suspense>
  );
}
