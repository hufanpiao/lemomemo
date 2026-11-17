// FormButton（B2-UI-a U3-1）：六种 variant（R-454 加 textDanger） 各对一个类；老写法 danger（布尔）等于 variant="danger"；
// strong 加字重 600 的类（代码审 M2：设置 › 提醒的“重新连接”“移除它…”“取消”保持 600，编辑页“删除”不传、保持 400）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormButton, type ButtonVariant } from '../Form.tsx';
import styles from '../Form.module.css';

afterEach(cleanup);

const CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.btn,
  danger: styles.danger,
  dangerFill: styles.dangerFill,
  ghost: styles.ghost,
  textDanger: styles.textDanger,
};

describe('FormButton', () => {
  it.each(Object.keys(CLASS) as ButtonVariant[])('variant=%s 用对应的类，不带 strong', (v) => {
    render(<FormButton variant={v}>按钮</FormButton>);
    const b = screen.getByRole('button', { name: '按钮' });
    expect(b.className.split(' ')).toContain(CLASS[v]);
    expect(b.className.split(' ')).not.toContain(styles.strong);
  });

  it('不写 variant 是 secondary；老写法 danger 等于 variant="danger"', () => {
    render(
      <>
        <FormButton>普通</FormButton>
        <FormButton danger>删除</FormButton>
      </>,
    );
    // Pressable 自己还带一个类，这里只看 variant 的类
    expect(screen.getByRole('button', { name: '普通' }).className.split(' ')).toContain(styles.btn);
    expect(screen.getByRole('button', { name: '删除' }).className.split(' ')).toContain(styles.danger);
  });

  it('strong 在 variant 的类之外再加字重类', () => {
    render(
      <FormButton variant="ghost" strong>
        取消
      </FormButton>,
    );
    const cls = screen.getByRole('button', { name: '取消' }).className.split(' ');
    expect(cls).toEqual(expect.arrayContaining([styles.ghost, styles.strong]));
  });

  // B2-UI-b W4（D1 ①，R-276、R-277）：size、block 只加类，不换 variant 的类；默认 regular 不带这些类
  it('默认 regular：不带 compact、row、block 的类', () => {
    render(<FormButton>普通</FormButton>);
    const cls = screen.getByRole('button', { name: '普通' }).className.split(' ');
    for (const c of [styles.compact, styles.row, styles.block]) expect(cls).not.toContain(c);
  });

  it('size="compact" 加 compact 类、保留 variant 的类；block 加整行宽类', () => {
    render(
      <>
        <FormButton size="compact">重试</FormButton>
        <FormButton size="compact" danger>移除</FormButton>
        <FormButton size="compact" variant="primary">确定</FormButton>
        <FormButton size="compact" block>退出其他所有设备</FormButton>
      </>,
    );
    const of = (name: string) => screen.getByRole('button', { name }).className.split(' ');
    expect(of('重试')).toEqual(expect.arrayContaining([styles.btn, styles.compact]));
    expect(of('重试')).not.toContain(styles.row);
    expect(of('移除')).toEqual(expect.arrayContaining([styles.danger, styles.compact]));
    expect(of('确定')).toEqual(expect.arrayContaining([styles.primary, styles.compact]));
    expect(of('退出其他所有设备')).toEqual(expect.arrayContaining([styles.btn, styles.compact, styles.block]));
  });

  it('size="row"：compact 的外观再加 row（看得见 44，R-277）', () => {
    render(
      <FormButton size="row" block>
        退出登录
      </FormButton>,
    );
    const cls = screen.getByRole('button', { name: '退出登录' }).className.split(' ');
    expect(cls).toEqual(expect.arrayContaining([styles.btn, styles.compact, styles.row, styles.block]));
  });

  // R-454：textDanger（账号页设备行的“退出这台设备”“移除”）点击区 44 见方：高来自公共底座那组，宽它自己写
  it('textDanger：公共底座组里带 min-height: var(--hit)，自己的规则带 min-width: var(--hit)；禁用和别的变体一样变淡', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'Form.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => ({ sel: (sel ?? '').split(',').map((x) => x.trim()), body: body ?? '' }));
    const base = rules.find((r) => r.sel.includes('.textDanger') && r.sel.includes('.btn'));
    expect(base?.body).toContain('min-height: var(--hit)');
    const own = rules.find((r) => r.sel.length === 1 && r.sel[0] === '.textDanger');
    expect(own?.body).toContain('min-width: var(--hit)');
    expect(own?.body).not.toContain('min-height');
    expect(rules.some((r) => r.sel.includes('.textDanger:disabled') && r.sel.includes('.btn:disabled'))).toBe(true);
  });
});
