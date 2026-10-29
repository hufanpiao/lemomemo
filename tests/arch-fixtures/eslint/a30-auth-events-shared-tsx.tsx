// arch-fixture: path=shared/ui/auth-watch.tsx expect=lemo/auth-events-in-session rule=A30 message=A30 count=2
// 违规：shared 的 .tsx 也查（K6-sugg3 ⑤：配置和架构 2.3 A30 统一成 shared 的 ts / tsx / js / mjs）
type Db = { auth: { onAuthStateChange(fn: (e: string) => void): unknown } };
export function watch(db: Db, out: () => void): unknown {
  return db.auth['onAuthStateChange']((e) => e === 'SIGNED_OUT' && out());
}
