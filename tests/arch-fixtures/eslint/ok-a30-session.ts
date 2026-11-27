// arch-fixture: path=src/platform/session.ts expect=none
// 对照：会话层本身可以订阅、认 SIGNED_OUT
type Auth = { onAuthStateChange(cb: (e: string) => void): void };
export function listen(auth: Auth, out: () => void): void {
  auth.onAuthStateChange((e) => {
    if (e === 'SIGNED_OUT') out();
  });
}
