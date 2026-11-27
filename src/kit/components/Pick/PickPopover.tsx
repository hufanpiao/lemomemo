// 不在表单行里的下拉单选（不用原生 select：随手记编辑页的分类胶囊、下拉搜索的“查找范围”）：
// 触发按钮由用的地方画（保持原来的样子），点了在旁边弹 kit 的 Popover，里面是 Pick 的 OptionPick（同一套小胶囊），点一下选中就收起。
// 单独一个文件：编辑页只引 Pick.tsx，不跟着带上 Radix 浮层
import { useState, type ReactElement } from 'react';
import { Popover } from '../Popover.tsx';
import { OptionPick, type OptionPickProps } from './Pick.tsx';
import s from './Pick.module.css';

export function PickPopover({ trigger, label, value, options, onPick, testId, align }: OptionPickProps & { trigger: ReactElement; align?: 'start' | 'center' | 'end' }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover trigger={trigger} label={label} open={open} onOpenChange={setOpen} className={s.pop} {...(align ? { align } : {})}>
      <OptionPick
        label={label}
        value={value}
        options={options}
        testId={testId}
        onPick={(v) => {
          setOpen(false);
          if (v !== value) onPick(v);
        }}
      />
    </Popover>
  );
}
