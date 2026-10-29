// arch-fixture: path=shared/logic/auth-watch.js expect=lemo/auth-events-in-session rule=A30 message=A30 count=2
// 违规：shared 里的 .js 也查（K6-signedout-sugg ③ 扩到 shared/ 和 .js）；解构出来再调也算
export function watch(db, out) {
  const { onAuthStateChange } = db.auth;
  return onAuthStateChange((e) => e === 'SIGNED_OUT' && out());
}
