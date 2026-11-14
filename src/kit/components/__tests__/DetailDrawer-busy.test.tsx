// 电脑详情抽屉和升级中心的 busy（B6 独立评审第 12 条）：抽屉在电脑上可能开一整天，一直占着 busy 新版本横幅就永远不出、也不自动重新载入。
// • 焦点在抽屉里（含抽屉里弹出的 radix 浮层）才占 busy；焦点去了抽屉外面就放开，回来再占
// • 抽屉里的编辑器（EditShell 给了 onClose）自己不再占；整页编辑照旧占
// • 顺带：initial 选的元素晚一步才画出来（编辑器按需下载）时，出来以后焦点挪过去；这期间焦点被挪走了就不抢
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../state/ui-store.ts';
import { DetailDrawer } from '../DetailDrawer.tsx';
import { EditShell } from '../EditShell.tsx';

const fx = vi.hoisted(() => ({ busy: [] as string[] }));
vi.mock('../../../core/boot.ts', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const fake = { upgrade: { holdBusy: (r: string) => (fx.busy.push(r), () => void fx.busy.splice(fx.busy.indexOf(r), 1)) } };
  return { ...real, getBoot: () => fake };
});

beforeEach(() => {
  fx.busy.length = 0;
  uiStore.setState({ locale: 'zh-CN' });
});
afterEach(cleanup);

const rec = { row: { id: 'a' }, status: 'idle' as const, readonly: false, deleted: false, setDeleted: async () => 'idle' as const };
const own = { empty: '写上标题才会保存', rejected: '格式不对' };

function drawer() {
  return render(
    <>
      <button type="button" data-testid="outside">
        列表里的一行
      </button>
      <DetailDrawer id="todo:a" label="详情" onClose={() => undefined} refocus={() => null} data-testid="drawer">
        <EditShell kind="待办" backLabel="返回" onBack={() => undefined} onClose={() => undefined} rec={rec} own={own} prefix="todo-edit">
          <input data-testid="field" />
        </EditShell>
        <div data-radix-popper-content-wrapper="">
          <button type="button" data-testid="pop">
            浮层里的按钮
          </button>
        </div>
      </DetailDrawer>
    </>,
  );
}

describe('DetailDrawer 的 busy', () => {
  it('打开时焦点进抽屉：占一个 editing（抽屉里的 EditShell 自己不占）', () => {
    drawer();
    expect(fx.busy).toEqual(['editing']);
  });

  it('焦点去了抽屉外面就放开；点回抽屉里又占；去 radix 浮层不放开', () => {
    drawer();
    const field = screen.getByTestId('field');
    act(() => field.focus());
    expect(fx.busy).toEqual(['editing']);
    act(() => screen.getByTestId('pop').focus());
    expect(fx.busy).toEqual(['editing']);
    act(() => screen.getByTestId('outside').focus());
    expect(fx.busy).toEqual([]);
    act(() => field.focus());
    expect(fx.busy).toEqual(['editing']);
    // 切走窗口（relatedTarget 为空）也算离开
    act(() => {
      fireEvent.blur(field, { relatedTarget: null });
    });
    expect(fx.busy).toEqual([]);
  });

  it('整页编辑（没给 onClose）照旧一挂上就占', () => {
    render(
      <EditShell kind="待办" backLabel="返回" onBack={() => undefined} rec={rec} own={own} prefix="todo-edit">
        {null}
      </EditShell>,
    );
    expect(fx.busy).toEqual(['editing']);
  });
});

describe('DetailDrawer 的初始焦点', () => {
  function Late({ show }: { show: boolean }) {
    return (
      <>
        <button type="button" data-testid="outside">
          外面
        </button>
        <DetailDrawer id="note:a" label="详情" onClose={() => undefined} refocus={() => null} initial='[data-testid="body"]' data-testid="drawer">
          {show ? <textarea data-testid="body" /> : null}
        </DetailDrawer>
      </>
    );
  }
  function Host() {
    const [show, setShow] = useState(false);
    return (
      <>
        <button type="button" data-testid="show" onClick={() => setShow(true)} />
        <Late show={show} />
      </>
    );
  }

  it('正文框晚画出来：先落在抽屉本身，出来以后挪到正文框', async () => {
    render(<Host />);
    expect(document.activeElement).toBe(screen.getByTestId('drawer'));
    act(() => screen.getByTestId('show').click());
    // click() 不挪焦点（按钮没 focus），焦点还在抽屉本身
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('body')));
  });

  it('等的时候焦点被挪走了：出来以后不抢', async () => {
    render(<Host />);
    act(() => screen.getByTestId('outside').focus());
    act(() => screen.getByTestId('show').click());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(screen.getByTestId('outside'));
  });
});
