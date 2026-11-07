// FormButton（B2-UI-a U3-1）：五种 variant 各对一个类；老写法 danger（布尔）等于 variant="danger"；
// strong 加字重 600 的类（代码审 M2：设置 › 提醒的“重新连接”“移除它…”“取消”保持 600，编辑页“删除”不传、保持 400）
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
});
