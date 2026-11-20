// SyncDropped、SyncStale 合成一个内部 AckTip 以后（改善报告第七节）：DOM 和合一前的原写法逐字节一样；没有要报的不画；点“知道了”收对应那一种
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Pressable } from '../../../motion/components.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import styles from '../ui/NotesPage.module.css';

const sync = vi.hoisted(() => ({ dropped: 0, stale: 0, ack: vi.fn(), ackStale: vi.fn() }));
vi.mock('../hooks/note-source.ts', () => ({ useNoteSource: () => ({ useSync: () => sync }) }));

const { SyncDropped, SyncStale } = await import('../ui/NotesBits.tsx');

/** 合一前 SyncDropped 的原写法（只用来比 DOM） */
function OldDropped() {
  const t = useNotesT();
  return (
    <p className={styles.error} role="alert" data-testid="notes-sync-dropped">
      {t('notes.sync.dropped', { n: sync.dropped })}
      <Pressable type="button" className={styles.tipLink} onClick={sync.ack} data-testid="notes-sync-dropped-ok">
        {t('notes.sync.ok', {})}
      </Pressable>
    </p>
  );
}

/** 合一前 SyncStale 的原写法（只用来比 DOM） */
function OldStale() {
  const t = useNotesT();
  return (
    <p className={styles.error} role="alert" data-testid="notes-sync-stale">
      {t('notes.sync.stale', {})}
      <Pressable type="button" className={styles.tipLink} onClick={sync.ackStale} data-testid="notes-sync-stale-ok">
        {t('notes.sync.ok', {})}
      </Pressable>
    </p>
  );
}

/** 画出来的那一块（节点本身留着，用 isEqualNode 逐节点比标签、属性、文字） */
const dom = (el: ReactElement): HTMLElement => render(el).container;

afterEach(() => {
  cleanup();
  sync.dropped = 0;
  sync.stale = 0;
  sync.ack.mockClear();
  sync.ackStale.mockClear();
});

describe('SyncDropped / SyncStale', () => {
  it('没有要报的不画', () => {
    expect(dom(<SyncDropped />).childNodes).toHaveLength(0);
    expect(dom(<SyncStale />).childNodes).toHaveLength(0);
  });

  it('DOM 和合一前逐节点一样（标签、属性、文字）', () => {
    sync.dropped = 3;
    sync.stale = 1;
    const dropped = dom(<SyncDropped />);
    expect(dropped.childNodes).toHaveLength(1);
    expect(dropped.isEqualNode(dom(<OldDropped />))).toBe(true);
    expect(dom(<SyncStale />).isEqualNode(dom(<OldStale />))).toBe(true);
    // 比法本身管用：两句互比不相等
    expect(dropped.isEqualNode(dom(<OldStale />))).toBe(false);
  });

  it('点“知道了”收对应那一种', () => {
    sync.dropped = 2;
    sync.stale = 1;
    render(
      <>
        <SyncDropped />
        <SyncStale />
      </>,
    );
    fireEvent.click(screen.getByTestId('notes-sync-dropped-ok'));
    expect(sync.ack).toHaveBeenCalledTimes(1);
    expect(sync.ackStale).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('notes-sync-stale-ok'));
    expect(sync.ackStale).toHaveBeenCalledTimes(1);
  });
});
