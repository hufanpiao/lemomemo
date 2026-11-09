// FormButton（B2-UI-a U3-1）：五种 variant 各对一个类；老写法 danger（布尔）等于 variant="danger"；
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

  // R-366（负责人 11-09 选 D5 方案 A）：outline 只配合 compact，只改底色和描边；高度、圆角、点击区照 compact
  it('outline：只在 size="compact" 时加 outline 类，其他 size 传了也不加', () => {
    render(
      <>
        <FormButton size="compact" block outline>退出其他所有设备</FormButton>
        <FormButton outline>普通</FormButton>
        <FormButton size="row" outline>退出登录</FormButton>
      </>,
    );
    const of = (name: string) => screen.getByRole('button', { name }).className.split(' ');
    expect(of('退出其他所有设备')).toEqual(expect.arrayContaining([styles.btn, styles.compact, styles.block, styles.outline]));
    expect(of('普通')).not.toContain(styles.outline);
    expect(of('退出登录')).not.toContain(styles.outline);
  });

  it('outline 的 CSS 只写底色和描边；高度、圆角、点击区（::after）都不另写，跟 compact 一样', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'Form.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => /\.outline(?![\w-])/.test(sel ?? ''));
    expect(rules.map(([, sel]) => sel?.trim())).toEqual(['.compact.btn.outline']);
    const props = (rules[0]?.[2] ?? '').split(';').map((d) => d.split(':')[0]?.trim()).filter(Boolean).sort();
    expect(props).toEqual(['background', 'border']);
    expect(rules[0]?.[2]).toContain('border: 1px solid var(--inp-line)');
    // 选择器三个类，写在 .block.compact.btn（也是三个类）后面，才压得住它的 --panel 底色
    expect(css.indexOf('.compact.btn.outline')).toBeGreaterThan(css.indexOf('.block.compact.btn'));
  });
});
