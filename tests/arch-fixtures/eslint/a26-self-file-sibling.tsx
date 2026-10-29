// arch-fixture: path=src/app/router.tsx expect=lemo/safe-href message=A26 rule=A26
// 违规：自家文件的豁免只给真正的 src/app/router.ts；同名的 router.tsx 里自己定义的 hrefOf 不算
function hrefOf(name: string) {
  return name;
}
export const Bad = ({ u }: { u: string }) => <a href={hrefOf(u)}>a</a>;
