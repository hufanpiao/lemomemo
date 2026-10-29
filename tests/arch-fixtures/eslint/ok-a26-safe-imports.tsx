// arch-fixture: path=src/features/notes/ui/Ok.tsx expect=none
// 对照组（A26）：别名导入、命名空间导入、相对路径不同写法（多余的 ./、../.././）都认（都要写全 .ts 后缀）；
// 展开对象里的 href 经 safeHref 也认；自定义组件上的展开不管
import { safeHref as toHref } from '../../../../shared/logic/link.ts';
import * as link from '../.././../../shared/logic/link.ts';
import { safeHref } from './../../../../shared/logic/link.ts';
import { hrefOf } from '../../../app/router.ts';

function Card(props: { href?: string; title: string }) {
  return <span title={props.title}>{props.href === undefined ? '' : toHref(props.href)}</span>;
}

export function Ok({ url, rest }: { url: string; rest: { href?: string; title: string } }) {
  return (
    <>
      <a href={toHref(url)}>a</a>
      <a href={link.safeHref(url)}>b</a>
      <a href={safeHref(url)}>c</a>
      <a href={hrefOf('today')}>d</a>
      <a {...{ href: safeHref(url), className: 'x' }}>e</a>
      <a {...{ title: url }} href="/x">
        f
      </a>
      <Card {...rest} />
    </>
  );
}
