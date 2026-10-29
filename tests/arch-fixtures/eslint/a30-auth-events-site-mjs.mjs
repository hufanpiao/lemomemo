// arch-fixture: path=site/auth-watch.mjs expect=lemo/auth-events-in-session rule=A30 message=A30 count=2
// 违规：官网 site 的 .mjs 也查（K6-sugg3 ⑤：配置和架构 2.3 A30 统一成 site 的 ts / tsx / js / mjs）
export function watch(db, out) {
  return db.auth.onAuthStateChange((e) => e === 'SIGNED_OUT' && out());
}
