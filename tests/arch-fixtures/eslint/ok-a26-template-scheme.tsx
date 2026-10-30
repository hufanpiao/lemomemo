// arch-fixture: path=src/features/notes/ui/Ok.tsx expect=none
// 对照组（FE-1030-sugg ④、A26-old-gaps ④）：不带插值、正好写成 .ts 的模板串来源不报；插值的模板串只要静态部分不指向
// link、router（普通的按语言加载）也不报；常量链接是相对地址、锚点、查询串或 http、https、tel、mailto 的都不报；
// 第十批审查建议：/app/x、?q=1、#a 不算协议相对地址；mailto 的 @、路径里的 @ 不算用户名（和 safeHref 一致）
export const load = (lang: string) => [
  import(`../../../../shared/logic/link.ts`),
  import(`./locales/${lang}.ts`),
  import(`./${lang}.ts`),
];
export const Ok = () => (
  <>
    <a href="/ko/privacy">a</a>
    <a href="https://lemomemo.com/">b</a>
    <a href="HTTP://example.com/">c</a>
    <a href="mailto:hi@lemomemo.com">d</a>
    <a href={`tel:+82-10-0000-0000`}>e</a>
    <a href="#top">f</a>
    <a href="?q=1">g</a>
    <a href="./notes/javascript:x">h</a>
    <img alt="" src="/icons/a.png" srcSet="/icons/a.png 1x, https://lemomemo.com/b.png 2x" />
    <a {...{ href: '/x', className: 'y' }}>i</a>
    <a href="/app/x">j</a>
    <a href="#a">k</a>
    <a href="mailto:hi@lemomemo.com?subject=x">l</a>
    <a href="https://lemomemo.com/a@b">m</a>
  </>
);
