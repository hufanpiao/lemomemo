// kit 的设置页卡片、行、分段按钮（SETTINGS-merge-cards；方案第 4、5、8 节）：结构、读屏名字和描述、点按、值先空着也能点、
// 说明和报错写在行里；样式只查几条关键数值是原样搬来的（行高 44、分段 32、值单行省略），完整的视觉核对等合卡接上以后跑 layout_audit
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Segmented, SettingsCard, SettingsEntryRow, SettingsRow, SettingsSegRow, SettingsSwitchRow } from '../Settings/Settings.tsx';

afterEach(cleanup);

describe('SettingsCard（M3）', () => {
  it('section 用看不见的 h2 当名字，里面是一个列表；行名不是标题', () => {
    render(
      <SettingsCard title="通用" testId="card">
        <SettingsEntryRow label="日历" value="节假日：中国" onOpen={() => undefined} testId="cal" />
        <SettingsRow>
          <span>别的内容</span>
        </SettingsRow>
      </SettingsCard>,
    );
    const card = screen.getByRole('region', { name: '通用' });
    expect(card).toBe(screen.getByTestId('card'));
    expect(within(card).getAllByRole('heading')).toHaveLength(1);
    expect(within(card).getByRole('heading', { level: 2 }).className).toMatch(/srOnly/);
    expect(within(within(card).getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('SettingsEntryRow（M4）', () => {
  it('整行一个按钮：名字含行名和值，› 不念；点了调 onOpen', () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <SettingsEntryRow label="日历" value="节假日：中国" onOpen={onOpen} testId="cal" valueTestId="cal-v" />
      </ul>,
    );
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('日历');
    expect(screen.getByTestId('cal-v').textContent).toBe('节假日：中国');
    expect(btn.querySelector('[aria-hidden]')?.textContent).toBe('›');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('值还没到（undefined）：行照样在、能点，值的位置空着；第二行灰字挂到按钮的 aria-describedby', () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <SettingsEntryRow label="提醒与通知" onOpen={onOpen} testId="rem" valueTestId="rem-v" meta="未来 7 天 8 条" />
      </ul>,
    );
    expect(screen.getByTestId('rem-v').textContent).toBe('');
    fireEvent.click(screen.getByTestId('rem'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const desc = screen.getByTestId('rem').getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('未来 7 天 8 条');
  });

  it('没有灰字时不写 aria-describedby；disabled 时点不动', () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <SettingsEntryRow label="数据" value="" onOpen={onOpen} testId="d" disabled />
      </ul>,
    );
    expect(screen.getByTestId('d').hasAttribute('aria-describedby')).toBe(false);
    fireEvent.click(screen.getByTestId('d'));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('SettingsSwitchRow（M2）', () => {
  it('开关的名字是行名，说明挂 aria-describedby；切换调 onChange(新值)', () => {
    const onChange = vi.fn();
    render(
      <ul>
        <SettingsSwitchRow label="示例开关" checked={false} onChange={onChange} note="示例说明" testId="sample" />
      </ul>,
    );
    const sw = screen.getByRole('switch', { name: '示例开关' });
    expect(sw).toBe(screen.getByTestId('sample'));
    const desc = sw.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('示例说明');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('报错写在同一行里（role=status），不在列表项外面；没有报错时没有这一段', () => {
    const { rerender } = render(
      <ul>
        <SettingsSwitchRow label="示例开关" checked onChange={() => undefined} testId="sample" />
      </ul>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('sample').hasAttribute('aria-describedby')).toBe(false);
    rerender(
      <ul>
        <SettingsSwitchRow label="示例开关" checked={false} onChange={() => undefined} error="示例报错" testId="sample" />
      </ul>,
    );
    const err = screen.getByRole('status');
    expect(err.textContent).toBe('示例报错');
    expect(err.closest('li')).toBe(screen.getByTestId('sample').closest('li'));
  });
});

describe('Segmented 和 SettingsSegRow（C、M1）', () => {
  const opts = [
    { value: 'zh', label: '中文', lang: 'zh' },
    { value: 'ko', label: '한국어', lang: 'ko' },
  ] as const;

  it('组名取行名；选中的 aria-pressed=true；点另一个调 onChange；选项带 lang', () => {
    const onChange = vi.fn();
    render(
      <ul>
        <SettingsSegRow label="界面语言" options={opts} value="zh" onChange={onChange} testId="lang" meta="提醒和邮件也会改用这种语言" />
      </ul>,
    );
    const g = screen.getByRole('group', { name: '界面语言' });
    expect(g).toBe(screen.getByTestId('lang'));
    expect(within(g).getByRole('button', { name: '中文' }).getAttribute('aria-pressed')).toBe('true');
    const ko = within(g).getByRole('button', { name: '한국어' });
    expect(ko.getAttribute('aria-pressed')).toBe('false');
    expect(ko.getAttribute('lang')).toBe('ko');
    fireEvent.click(ko);
    expect(onChange).toHaveBeenCalledWith('ko');
    expect(screen.getByText('提醒和邮件也会改用这种语言').closest('li')).toBe(g.closest('li'));
    const d = g.getAttribute('aria-describedby');
    expect(d && document.getElementById(d)?.textContent).toBe('提醒和邮件也会改用这种语言');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('同步失败的报错写在行里（role=alert）', () => {
    render(
      <ul>
        <SettingsSegRow label="界面语言" options={opts} value="ko" onChange={() => undefined} error="没能同步到其他设备" />
      </ul>,
    );
    expect(screen.getByRole('alert').closest('li')).toBe(screen.getByRole('group').closest('li'));
  });

  it('单独用时可以直接给 label', () => {
    render(<Segmented options={opts} value="zh" onChange={() => undefined} label="语言" />);
    expect(screen.getByRole('group', { name: '语言' })).toBeTruthy();
  });
});

describe('样式数值原样搬来（R-276、R-282）、值单行省略（M4、S3）', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'Settings', 'Settings.module.css'), 'utf8');
  const rule = (sel: string): string => {
    const i = css.indexOf(`\n${sel} {`);
    if (i < 0) throw new Error(`没有 ${sel}`);
    return css.slice(i, css.indexOf('}', i));
  };
  it('行 44、入口按钮 44、分段按钮 32 加扩到 44 的点击区、开关 48×28', () => {
    expect(rule('.row')).toContain('min-height: var(--hit);');
    expect(rule('.rowBtn')).toContain('min-height: var(--hit);');
    expect(rule('.segBtn')).toContain('min-height: 32px;');
    expect(rule('.segBtn::after')).toContain('height: max(100%, var(--hit));');
    // 开关画法 B2-UI-b W5 挪到 kit 共用开关，11-09 并进 Form.module.css 的 .switch，48×28 不变；设置行里不能再留一份，单独的 Switch.module.css 也已删掉
    const sw = readFileSync(join(import.meta.dirname, '..', 'Form.module.css'), 'utf8');
    expect(existsSync(join(import.meta.dirname, '..', 'Switch.module.css'))).toBe(false);
    expect(sw).toMatch(/\n\.switch \{[^}]*width: 48px;[^}]*height: 28px;/);
    expect(css).not.toContain('.toggle');
  });
  it('值单行省略；行名不省略（换行）', () => {
    const v = rule('.v');
    for (const d of ['white-space: nowrap;', 'text-overflow: ellipsis;', 'overflow: hidden;', 'min-width: 0;']) expect(v).toContain(d);
    expect(rule('.tx')).toContain('overflow-wrap: anywhere;');
    expect(rule('.tx')).not.toContain('ellipsis');
  });
});

describe('SettingsEntryRow stacked（韩文审校 A-4：设置首页账号一行）', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'Settings', 'Settings.module.css'), 'utf8');
  const rule = (sel: string): string => {
    const i = css.indexOf(`\n${sel} {`);
    if (i < 0) throw new Error(`没有 ${sel}`);
    return css.slice(i, css.indexOf('}', i));
  };
  it('行名在上、值在下，同在一个竖排容器里；值不省略、可换行', () => {
    render(
      <ul>
        <SettingsEntryRow label="a-very-long-mail@example.com" value="设备列表读不出来" stacked onOpen={() => undefined} testId="acc" valueTestId="acc-v" />
      </ul>,
    );
    const v = screen.getByTestId('acc-v');
    const box = v.parentElement as HTMLElement;
    expect(box.parentElement).toBe(screen.getByTestId('acc'));
    expect([...box.children].map((c) => c.textContent)).toEqual(['a-very-long-mail@example.com', '设备列表读不出来']);
    expect(v.className).toMatch(/vBelow/);
    const below = rule('.vBelow');
    for (const d of ['white-space: normal;', 'overflow: visible;', 'text-align: left;', 'overflow-wrap: anywhere;']) expect(below).toContain(d);
    expect(rule('.stack')).toContain('flex-direction: column;');
  });

  it('不带 stacked：行名和值仍是按钮里并排的两个（原样）', () => {
    render(
      <ul>
        <SettingsEntryRow label="日历" value="节假日：中国" onOpen={() => undefined} testId="cal" valueTestId="cal-v" />
      </ul>,
    );
    expect(screen.getByTestId('cal-v').parentElement).toBe(screen.getByTestId('cal'));
  });
});

