// kit 选择器（Pick/Pick.tsx；11-21 负责人“只要是ios默认框的能换就换”，定稿 方案-v2 第一套）：
// 就地展开在字段行下面、“确定”才交、能清空的才有“清空”、范围外灰掉、跨夜提示、“从”“到”一样时“确定”变灰、下拉点一下选中就收起、一组只开一个、读屏名字；
// 11-22 评审整改：周起始跟设置（1）、Esc 走层栈（3）、radiogroup + 方向键（8）、焦点还给打开它的按钮（9）、草稿日期在范围外“确定”变灰（12）、
// 跨年标题（14）、开着时外面的值变了直接收起（15）
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Field, FormGroup } from '../Form.tsx';
import { DateTimeField, Select } from '../Pick/Pick.tsx';

const rows = vi.hoisted(() => ({ settings: [] as unknown[] }));
vi.mock('../../hooks/useCollection.ts', () => ({ useCollection: () => rows.settings }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // UTC 中午：UTC、首尔、洛杉矶三个时区都是 11-21（原来 03:00Z 在洛杉矶是 11-20，ci 洛杉矶作业挂）
  vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
  rows.settings = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const panel = (): HTMLElement => screen.getByRole('group', { name: '截止日' });
/** 日期滑条（负责人 11-23“做成跟时间一样的那种滑动”）上看得见的 7 天：从滑条 data-first 那天起 */
const shown = (): HTMLElement[] => {
  const g = panel().querySelector<HTMLElement>('[data-first]');
  const xs = g ? [...g.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
  const i = xs.findIndex((c) => c.dataset['v'] === g?.dataset['first']);
  return xs.slice(i, i + 7);
};
const radio = (name: string): HTMLButtonElement => screen.getByRole('radio', { name }) as HTMLButtonElement;

describe('日期（待办截止日：能清空）', () => {
  it('点值按钮在这一行下面就地展开；选一天、点“确定”才交', () => {
    const onDone = vi.fn();
    render(
      <FormGroup>
        <Field label="截止日">
          <DateTimeField mode="date" date="2026-11-22" onDone={onDone} onClear={() => undefined} testIds={{ date: 'due' }} />
        </Field>
      </FormGroup>,
    );
    const btn = screen.getByTestId('due');
    expect(btn.textContent).toBe('11月22日 周日');
    expect(btn.getAttribute('aria-label')).toBe('截止日 11月22日 周日');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    // 画在字段行下面的展开格里（不是右边的控件格）
    expect(panel().parentElement?.previousElementSibling?.contains(btn)).toBe(true);
    expect(within(panel()).getByRole('radio', { name: '11月22日 周日' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(panel()).getByRole('radio', { name: '11月25日 周三' }));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('pick-ok'));
    expect(onDone).toHaveBeenCalledWith({ date: '2026-11-25', time: '09:00' });
    expect(screen.queryByRole('group', { name: '截止日' })).toBeNull();
  });

  it('今天标出来（data-today、读屏名带“今天”），周标题“2026年11月”，‹ › 换周', () => {
    render(
      <Field label="截止日">
        <DateTimeField mode="date" date={null} onDone={() => undefined} onClear={() => undefined} testIds={{ date: 'due' }} />
      </Field>,
    );
    expect(screen.getByTestId('due').textContent).toBe('选日期');
    fireEvent.click(screen.getByTestId('due'));
    const today = within(panel()).getByRole('radio', { name: '11月21日 周六 今天' });
    expect(today.hasAttribute('data-today')).toBe(true);
    // 没值时草稿是今天
    expect(today.getAttribute('aria-checked')).toBe('true');
    expect(panel().textContent).toContain('2026年11月');
    fireEvent.click(screen.getByTestId('pick-next'));
    expect(panel().textContent).toContain('2026年11月');
    fireEvent.click(screen.getByTestId('pick-next'));
    expect(panel().textContent).toContain('11月–12月');
  });

  it('跨年那一周标题两头带年份（评审第 14 条）', () => {
    render(
      <Field label="截止日">
        <DateTimeField mode="date" date="2026-12-30" onDone={() => undefined} testIds={{ date: 'due' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('due'));
    expect(panel().textContent).toContain('2026年12月–2027年1月');
  });

  it('一周从哪天起跟日历设置 cal.week_start（评审第 1 条）：没设从周日起，设成周一就从周一起，星期小字跟着轮转', () => {
    const { unmount } = render(
      <Field label="截止日">
        <DateTimeField mode="date" date="2026-11-22" onDone={() => undefined} testIds={{ date: 'due' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('due'));
    let cells = shown();
    expect(cells[0]?.getAttribute('data-v')).toBe('2026-11-22');
    expect(cells[0]?.querySelector('i')?.textContent).toBe('日');
    unmount();
    rows.settings = [{ id: 's1', key: 'cal.week_start', value: 1 }];
    render(
      <Field label="截止日">
        <DateTimeField mode="date" date="2026-11-22" onDone={() => undefined} testIds={{ date: 'due' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('due'));
    cells = shown();
    expect(cells[0]?.getAttribute('data-v')).toBe('2026-11-16');
    expect(cells[0]?.querySelector('i')?.textContent).toBe('一');
    expect(cells[6]?.getAttribute('data-v')).toBe('2026-11-22');
    expect(cells[6]?.querySelector('i')?.textContent).toBe('日');
  });

  it('跳月（负责人 11-23）：标题是按钮、aria-expanded；点了换成月份列表，跨年、方向键挪、回车选，跳到那个月第一周；Esc 只收列表、焦点回标题', () => {
    const onDone = vi.fn();
    render(
      <Field label="截止日">
        <DateTimeField mode="date" date="2026-11-22" onDone={onDone} testIds={{ date: 'due' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('due'));
    const title = screen.getByTestId('pick-title');
    expect(title.tagName).toBe('BUTTON');
    expect(title.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(title);
    expect(title.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('radiogroup', { name: '选月份' });
    expect(title.getAttribute('aria-controls')).toBe(list.id);
    // 正在看的月是选中的那格、能 Tab 到；往后 24 个月、跨年
    const nov = within(list).getByRole('radio', { name: '2026年11月' });
    expect(nov.getAttribute('aria-checked')).toBe('true');
    expect(nov.tabIndex).toBe(0);
    expect(within(list).getByRole('radio', { name: '2028年11月' })).toBeTruthy();
    expect(list.textContent).toContain('2027年');
    // 键盘：→ 挪到 12 月，回车（按钮的 click）选中
    nov.focus();
    fireEvent.keyDown(nov, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('2026年12月');
    fireEvent.click(within(list).getByRole('radio', { name: '2027年2月' }));
    expect(screen.queryByRole('radiogroup', { name: '选月份' })).toBeNull();
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(panel().textContent).toContain('1月–2月');
    const days = shown();
    expect(days[0]?.getAttribute('data-v')).toBe('2027-01-31');
    // 草稿不动（这一周里没有选中的格），点一天才换
    expect(days.some((d) => d.getAttribute('aria-checked') === 'true')).toBe(false);
    fireEvent.click(panel().querySelector('[data-v="2027-02-03"]') as HTMLElement);
    // Esc 只收起月份列表，选择器还开着
    fireEvent.click(title);
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(screen.queryByRole('radiogroup', { name: '选月份' })).toBeNull();
    expect(panel()).toBeTruthy();
    expect(document.activeElement).toBe(title);
    fireEvent.click(screen.getByTestId('pick-ok'));
    expect(onDone).toHaveBeenCalledWith({ date: '2027-02-03', time: '09:00' });
  });

  it('能清空的才有“清空”：点了交 onClear 并收起；不能清空的没有', () => {
    const onClear = vi.fn();
    const { unmount } = render(
      <Field label="截止日">
        <DateTimeField mode="date" date="2026-11-22" onDone={() => undefined} onClear={onClear} testIds={{ date: 'due' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('due'));
    fireEvent.click(screen.getByTestId('pick-clear'));
    expect(onClear).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: '截止日' })).toBeNull();
    unmount();
    render(
      <Field label="提醒时刻">
        <DateTimeField mode="time" time="09:00" onDone={() => undefined} testIds={{ time: 'rt' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('rt'));
    expect(screen.queryByTestId('pick-clear')).toBeNull();
  });

  it('Esc（层栈，评审第 3 条）收起，焦点回到值按钮', () => {
    render(
      <Field label="截止日">
        <DateTimeField mode="date" date="2026-11-22" onDone={() => undefined} testIds={{ date: 'due' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('due'));
    const d23 = within(panel()).getByRole('radio', { name: '11月23日 周一' });
    d23.focus();
    fireEvent.keyDown(d23, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: '截止日' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('due'));
  });

  it('读屏和键盘（评审第 8 条）：一组里只有选中的那格能 Tab 到，方向键在组里挪焦点、不选中', () => {
    render(
      <Field label="截止日">
        <DateTimeField mode="date" date="2026-11-24" onDone={() => undefined} testIds={{ date: 'due' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('due'));
    const cells = shown();
    expect(cells.map((c) => c.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1, -1]);
    cells[2]?.focus();
    fireEvent.keyDown(cells[2] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[3]);
    fireEvent.keyDown(cells[3] as HTMLElement, { key: 'ArrowLeft' });
    fireEvent.keyDown(cells[2] as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cells[1]);
    expect(cells[2]?.getAttribute('aria-checked')).toBe('true');
    // 翻到没有草稿那天的一周：第一个能选的那格能 Tab 到
    fireEvent.click(screen.getByTestId('pick-next'));
    expect(shown().map((c) => c.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    expect(within(panel()).getAllByRole('radio').filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it('开着的时候外面的值变了直接收起（评审第 15 条）', () => {
    const view = (date: string) => (
      <Field label="截止日">
        <DateTimeField mode="date" date={date} onDone={() => undefined} testIds={{ date: 'due' }} />
      </Field>
    );
    const { rerender } = render(view('2026-11-22'));
    fireEvent.click(screen.getByTestId('due'));
    expect(screen.queryByRole('group', { name: '截止日' })).not.toBeNull();
    rerender(view('2026-11-22'));
    expect(screen.queryByRole('group', { name: '截止日' })).not.toBeNull();
    rerender(view('2026-11-30'));
    expect(screen.queryByRole('group', { name: '截止日' })).toBeNull();
  });
});

describe('日程结束（开始当天到 +30 天、跨夜）', () => {
  // 跨夜的判断在 calendar 的 endsNextDay（kit 不引 features），这里写个一样的
  const nextDay = (v: { date: string; time: string }): boolean => v.date === '2026-11-22' && v.time <= '15:00';
  const renderEnd = (onDone = vi.fn(), date = '2026-11-22') =>
    render(
      <Field label="结束">
        <DateTimeField
          mode="datetime"
          date={date}
          time="16:00"
          timeLabel="结束时刻"
          min="2026-11-22"
          max="2026-12-22"
          hint={(v) => (nextDay(v) ? { text: '比开始早，算到第二天' } : { text: '结束可选 11/22～12/22' })}
          onDone={onDone}
          testIds={{ date: 'ed', time: 'et' }}
        />
      </Field>,
    );

  it('范围外的日子灰掉、往前的周箭头禁用；时刻按钮读屏名是“结束时刻 16:00”', () => {
    renderEnd();
    expect(screen.getByTestId('et').getAttribute('aria-label')).toBe('结束时刻 16:00');
    fireEvent.click(screen.getByTestId('et'));
    const g = screen.getByRole('group', { name: '结束' });
    expect((within(g).getByRole('radio', { name: '11月22日 周日' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('pick-prev') as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByTestId('pick-next'));
    // 12-20 那一周：12-23 以后灰掉，往后的箭头禁用
    expect((within(g).getByRole('radio', { name: '12月22日 周二' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(g).getByRole('radio', { name: '12月23日 周三' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('pick-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('同一天选得比开始早：提示“算到第二天”，“确定”照样能按（跨夜）', () => {
    const onDone = vi.fn();
    renderEnd(onDone);
    fireEvent.click(screen.getByTestId('ed'));
    expect(screen.getByTestId('pick-hint').textContent).toBe('结束可选 11/22～12/22');
    fireEvent.click(radio('08 时'));
    expect(screen.getByTestId('pick-hint').textContent).toBe('比开始早，算到第二天');
    fireEvent.click(radio('30 分'));
    expect(radio('30 分').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('pick-ok'));
    expect(onDone).toHaveBeenCalledWith({ date: '2026-11-22', time: '08:30' });
  });

  it('草稿日期在 min～max 外（原来的值已经不在范围里）“确定”变灰，点一个能选的日子才亮（评审第 12 条）', () => {
    renderEnd(vi.fn(), '2026-11-20');
    fireEvent.click(screen.getByTestId('ed'));
    const ok = screen.getByTestId('pick-ok') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('pick-next'));
    fireEvent.click(radio('11月23日 周一'));
    expect(ok.disabled).toBe(false);
  });

  it('日期 + 时刻：焦点还给打开它的那个按钮（评审第 9 条）', () => {
    renderEnd();
    fireEvent.click(screen.getByTestId('et'));
    fireEvent.click(screen.getByTestId('pick-ok'));
    expect(document.activeElement).toBe(screen.getByTestId('et'));
    // Safari 点按钮不给它焦点、原来的焦点掉到 body（jsdom 的 click 不动焦点，这里手动 blur）
    screen.getByTestId('et').blur();
    fireEvent.click(screen.getByTestId('ed'));
    fireEvent.click(screen.getByTestId('pick-ok'));
    expect(document.activeElement).toBe(screen.getByTestId('ed'));
  });
});

describe('免打扰“从”“到”一样', () => {
  it('选成和另一头一样：提示红字、“确定”变灰；换开就能按', () => {
    const onDone = vi.fn();
    render(
      <Field label="免打扰 从">
        <DateTimeField mode="time" time="22:00" hint={(v) => (v.time === '08:00' ? { text: '“从”和“到”不能一样', bad: true } : null)} onDone={onDone} testIds={{ time: 'from' }} />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('from'));
    const ok = screen.getByTestId('pick-ok') as HTMLButtonElement;
    expect(ok.disabled).toBe(false);
    fireEvent.click(radio('08 时'));
    fireEvent.click(radio('00 分'));
    expect(ok.disabled).toBe(true);
    expect(screen.getByTestId('pick-hint').hasAttribute('data-bad')).toBe(true);
    fireEvent.click(ok);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(radio('05 分'));
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ time: '08:05' }));
  });
});

describe('下拉单选（原系统菜单）', () => {
  const opts = [
    { value: 'null', label: '不提醒' },
    { value: '0', label: '准时' },
    { value: '60', label: '1 小时' },
  ];

  it('点一下就选中并收起，不用“确定”；选回原来的不交', () => {
    const onChange = vi.fn();
    render(
      <Field label="提前提醒">
        <Select value="60" options={opts} onChange={onChange} data-testid="before" />
      </Field>,
    );
    const btn = screen.getByTestId('before');
    expect(btn.textContent).toBe('1 小时');
    expect(btn.getAttribute('aria-label')).toBe('提前提醒 1 小时');
    fireEvent.click(btn);
    const g = screen.getByRole('group', { name: '提前提醒' });
    expect(within(g).queryByTestId('pick-ok')).toBeNull();
    expect(within(g).queryByTestId('pick-clear')).toBeNull();
    expect(within(g).getByRole('radiogroup', { name: '提前提醒' })).not.toBeNull();
    expect(screen.getByTestId('before-opts-60').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('before-opts-60').tabIndex).toBe(0);
    expect(screen.getByTestId('before-opts-0').tabIndex).toBe(-1);
    fireEvent.click(screen.getByTestId('before-opts-0'));
    expect(onChange).toHaveBeenCalledWith('0');
    expect(screen.queryByRole('group', { name: '提前提醒' })).toBeNull();
    fireEvent.click(btn);
    fireEvent.click(screen.getByTestId('before-opts-60'));
    expect(onChange).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: '提前提醒' })).toBeNull();
  });

  it('禁用（只读）时点不开', () => {
    render(
      <Field label="提前提醒">
        <Select value="60" options={opts} onChange={() => undefined} disabled data-testid="before" />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('before'));
    expect(screen.queryByRole('group', { name: '提前提醒' })).toBeNull();
  });
});

describe('同一组同时只开一个', () => {
  it('开了提前提醒再点截止日：前一个收起', () => {
    render(
      <FormGroup>
        <Field label="截止日">
          <DateTimeField mode="date" date="2026-11-22" onDone={() => undefined} testIds={{ date: 'due' }} />
        </Field>
        <Field label="提前提醒">
          <Select value="0" options={[{ value: '0', label: '准时' }]} onChange={() => undefined} data-testid="before" />
        </Field>
      </FormGroup>,
    );
    fireEvent.click(screen.getByTestId('before'));
    expect(screen.queryByRole('group', { name: '提前提醒' })).not.toBeNull();
    fireEvent.click(screen.getByTestId('due'));
    expect(screen.queryByRole('group', { name: '提前提醒' })).toBeNull();
    expect(screen.queryByRole('group', { name: '截止日' })).not.toBeNull();
    // 再点一下同一个按钮收起
    fireEvent.click(screen.getByTestId('due'));
    expect(screen.queryByRole('group', { name: '截止日' })).toBeNull();
  });

  it('Field 默认自带一层（评审第 7 条）：一个 Field 里两个选择器也只开一个', () => {
    render(
      <Field label="开始">
        <DateTimeField mode="date" date="2026-11-22" onDone={() => undefined} testIds={{ date: 'a' }} />
        <Select value="0" label="提醒" options={[{ value: '0', label: '准时' }]} onChange={() => undefined} data-testid="b" />
      </Field>,
    );
    fireEvent.click(screen.getByTestId('a'));
    fireEvent.click(screen.getByTestId('b'));
    expect(screen.queryByRole('group', { name: '开始' })).toBeNull();
    expect(screen.queryByRole('group', { name: '提醒' })).not.toBeNull();
  });
});
