// B0 占位页上的“设置”入口（接手清单 PLACEHOLDER-settings-link；负责人 10-30 13:56 在 iPhone 主屏幕版发现：
// 注册后进到 today 只有占位页，主屏幕版没有地址栏，设置页、注销页都进不去）。B2 换真页面时连同本测试一起去掉
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ko } from '../../../../shared/i18n/ko.ts';
import { zh } from '../../../../shared/i18n/zh.ts';
import { hrefOf } from '../../../app/router.ts';
import { uiStore } from '../../state/ui-store.ts';
import { Placeholder } from '../Placeholder.tsx';
import styles from '../Placeholder.module.css';

beforeEach(() => act(() => uiStore.getState().setLocale('zh-CN')));
afterEach(cleanup);

describe('占位页的设置入口（PLACEHOLDER-settings-link）', () => {
  it('中文：有一个“设置”链接，指向 hrefOf("settings")，用触控区够大的那个样式', () => {
    render(<Placeholder feature="today" />);
    const link = screen.getByRole('link', { name: zh['app.settings'] });
    expect(zh['app.settings']).toBe('设置');
    expect(link.getAttribute('href')).toBe(hrefOf('settings'));
    expect(link.className).toContain(styles.settings);
  });

  it('韩文：“설정”', () => {
    act(() => uiStore.getState().setLocale('ko-KR'));
    render(<Placeholder feature="today" />);
    expect(ko['app.settings']).toBe('설정');
    expect(screen.getByRole('link', { name: '설정' }).getAttribute('href')).toBe('#/settings');
  });
});
