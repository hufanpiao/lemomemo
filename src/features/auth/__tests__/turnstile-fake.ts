// 登录页测试用的假 Turnstile（AuthPage.test.tsx、AuthPage.invite.test.tsx 共用）：
// 画小窗时马上给一个令牌，reset 时再给一个新的（真的令牌只能用一次）；记下每次画小窗用的 action
// 用法：vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule)
import { vi } from 'vitest';

export const turnstile = { mounted: 0, auto: true, n: 0, actions: [] as (string | undefined)[] };

export function resetTurnstileFake(): void {
  turnstile.mounted = 0;
  turnstile.auto = true;
  turnstile.n = 0;
  turnstile.actions = [];
}

export const fakeTurnstileModule = {
  mountTurnstile: vi.fn(async (_el: HTMLElement, opts: { callback?: (t: string) => void; action?: string }) => {
    turnstile.mounted += 1;
    turnstile.actions.push(opts.action);
    const give = () => {
      if (turnstile.auto) opts.callback?.(`tok-${++turnstile.n}`);
    };
    give();
    return { reset: give, remove: () => undefined };
  }),
};
