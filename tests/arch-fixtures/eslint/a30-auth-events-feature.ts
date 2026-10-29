// arch-fixture: path=src/features/settings/hooks/useSignedOut.ts expect=lemo/auth-events-in-session rule=A30 message=A30 count=4
// 违规：功能自己订阅 onAuthStateChange、自己认 SIGNED_OUT（应经 platform/session.ts 的 onAuthUser）
type Auth = { onAuthStateChange(cb: (e: string) => void): void };
export function listen(auth: Auth, out: () => void): void {
  auth.onAuthStateChange((e) => {
    if (e === 'SIGNED_OUT') out();
  });
  auth['onAuthStateChange']((e) => {
    if (e === `SIGNED_OUT`) out();
  });
}
