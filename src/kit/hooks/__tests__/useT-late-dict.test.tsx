// 公共词典晚到（独立评审 11-17 第 5 条）：useT 订阅 shared/i18n/i18n.ts 的词典仓库，界面是韩文、韩文那份还没下载时先用中文；
// 韩文那份一放进来，用到 useT 的组件不等别的状态变就重画成韩文
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { provideSharedDict, resetSharedDictsForTest } from '../../../../shared/i18n/i18n.ts';
import { ko } from '../../../../shared/i18n/ko.ts';
import { zh } from '../../../../shared/i18n/zh.ts';
import { uiStore } from '../../state/ui-store.ts';
import { useT } from '../useT.ts';

function Label() {
  const t = useT();
  return <p data-testid="label">{t('fmt.dur.mTail', { n: 7 })}</p>;
}

afterEach(() => {
  cleanup();
  // 回到公共准备的样子：只有中文
  resetSharedDictsForTest();
  provideSharedDict('zh-CN', zh);
  uiStore.getState().setLocale('zh-CN');
});

describe('useT 订阅公共词典', () => {
  it('韩文界面先用中文，韩文那份到了就重画成韩文', () => {
    uiStore.getState().setLocale('ko-KR');
    render(<Label />);
    expect(screen.getByTestId('label').textContent).toBe(zh['fmt.dur.mTail'].replace('{n}', '7'));
    act(() => provideSharedDict('ko-KR', ko));
    expect(screen.getByTestId('label').textContent).toBe(ko['fmt.dur.mTail'].replace('{n}', '7'));
  });
});
