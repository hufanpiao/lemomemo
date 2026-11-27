// 首屏后部分（GlassBarFx.tsx）下载失败（离线、分包 404；代码审查 L14）：外壳吞掉这次失败（不冒成未处理的拒绝、不进错误边界），
// 底栏照常能用：四个页签、“＋”、设置入口都在，没有模糊带。去掉外壳 import() 的 catch，vitest 会报未处理的拒绝，这个文件变红
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlassBar } from '../GlassBar.tsx';

vi.mock('../GlassBarFx.tsx', () => {
  throw new Error('分包下载失败（假的）');
});

afterEach(cleanup);

describe('GlassBar：首屏后部分下载失败', () => {
  it('外壳照常：页签、“＋”、设置入口都在，点“＋”有用；没有模糊带', async () => {
    const onAdd = vi.fn();
    render(<GlassBar active="today" add={{ label: '新建日程', onClick: onAdd }} />);
    await new Promise((r) => setTimeout(r, 50)); // 等 import() 失败那一下
    expect(document.querySelectorAll('a[data-tab]')).toHaveLength(4);
    expect(screen.getByTestId('tabbar-settings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新建日程' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tabbar-band')).toBeNull();
  });
});
