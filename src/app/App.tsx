// App 外壳：按 hash 路由挂页面（各页面懒加载，A27）
import { lazy, Suspense } from 'react';
import { useT } from '../kit/hooks/useT.ts';
import { isProduction } from './build-info.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { featureRoutes, type FeatureRoute } from './features.ts';
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

export function App() {
  const route = useRoute();
  const hit = [...featureRoutes, ...devRoutes].find((r) => r.name === route.name);
  const Page = hit?.Page;
  return (
    <ErrorBoundary key={route.name} fallback={<ErrorView />}>
      <Suspense fallback={null}>{Page ? <Page /> : <ErrorView />}</Suspense>
    </ErrorBoundary>
  );
}
