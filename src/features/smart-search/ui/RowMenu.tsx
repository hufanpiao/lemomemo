// 查找结果每行右边的“⋯”（B4b-3；线框 s12、sFind 每行都有“⋯”，菜单项照 sGest 手势表）：
// • 日程：编辑 / 删除；待办：完成 / 推迟到明天 / 改时间 / 删除；纪念日：编辑 / 删除；随手记：打开 / 删除；图片、文档：打开
// • “编辑”“改时间”“打开”进编辑页（同点这一行）；随手记的“转成待办 / 转成日程 / 移到隐私记”、纪念日的“生成待办”要进随手记、纪念日页里做（这一批不在查找里接）
// • 写入（完成、推迟、删除）交给 onAct，面板出“已删除 · 撤销”；“⋯”看得见 24px、点按区 44（kit 的 NoteRow 样式，和随手记列表同一套）
import { useState } from 'react';
import { Popover } from '../../../kit/components/Popover.tsx';
import row from '../../../kit/components/NoteRow.module.css';
import { Pressable } from '../../../motion/components.ts';
import type { FindItem, RowAct } from '../hooks/useFind.ts';
import { useFindT } from './find-parts.tsx';

type Item = 'open' | 'edit' | 'retime' | RowAct;

const ITEMS: Record<FindItem['kind'], readonly Item[]> = {
  event: ['edit', 'delete'],
  todo: ['done', 'tomorrow', 'retime', 'delete'],
  anniv: ['edit', 'delete'],
  note: ['open', 'delete'],
  image: ['open'],
  file: ['open'],
};

const LABEL = { open: 'find.m.open', edit: 'find.m.edit', retime: 'find.m.retime', done: 'find.m.done', tomorrow: 'find.m.tomorrow', delete: 'find.m.del' } as const satisfies Record<Item, string>;

export function RowMenu({ it, onOpen, onAct }: { it: FindItem; onOpen(): void; onAct(a: RowAct): void }) {
  const t = useFindT();
  const [open, setOpen] = useState(false);
  const items = ITEMS[it.kind].filter((x) => !(x === 'done' && it.done));
  const pick = (x: Item): void => {
    setOpen(false);
    if (x === 'open' || x === 'edit' || x === 'retime') onOpen();
    else onAct(x);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('find.more.label', {})}
      align="end"
      className={row.menu}
      trigger={
        <button type="button" className={row.more} aria-label={t('find.more.label', {})} data-testid="find-row-more">
          ⋯
        </button>
      }
    >
      {items.map((x) => (
        <Pressable key={x} className={x === 'delete' ? row.menuItem : `${row.menuItem} ${row.menuPlain}`} onClick={() => pick(x)} data-testid={`find-m-${x}`} data-no-proxy="">
          {t(LABEL[x], {})}
        </Pressable>
      ))}
    </Popover>
  );
}
