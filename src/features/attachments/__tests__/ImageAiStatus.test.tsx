// @vitest-environment jsdom
// B4b-2 识图：随手记图片下面的识别状态（线框 sAIst）。data/image-ai.ts 的状态判定 + ui/ImageAiStatus.tsx 的显示和两个按钮 + ui/ImageViewer.tsx 看图页
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageAiView, type Row } from '../data/image-ai.ts';
import type { RetryAiResult } from '../data/file-check-api.ts';
import type * as FileCheckApiNs from '../data/file-check-api.ts';

type FileCheckApi = typeof FileCheckApiNs;

const collections: Record<string, Row[]> = {};
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => collections[name] ?? [] }));
const retryAiCall = vi.fn<(id: string) => Promise<RetryAiResult>>();
vi.mock('../data/file-check-api.ts', () => ({ retryAiCall: (id: string) => retryAiCall(id) }));
const navigate = vi.fn(async () => undefined);
vi.mock('../../../app/router.ts', () => ({ navigate: (...a: unknown[]) => navigate(...(a as [])) }));
const lines: string[] = [];
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (l: string) => lines.push(l) }));

const { default: ImageAiStatus } = await import('../ui/ImageAiStatus.tsx');
const { default: ImageViewer } = await import('../ui/ImageViewer.tsx');

const ID = '0199a000-0000-7000-8000-000000000001';
const img = (o: Record<string, unknown>): Row => ({ id: ID, bucket: 'images', deleted_at: null, ai_status: 'pending', skip_reason: null, ai_desc: null, ai_tags: [], ...o });
const aiOn = (on: boolean) => {
  collections['settings'] = [{ id: 's', key: 'ai.enabled', value: on, deleted_at: null, undone: false }];
};

describe('imageAiView：行 → 显示哪一种', () => {
  it('五种状态和不显示的几种', () => {
    expect(imageAiView(img({}), true)).toEqual({ kind: 'pending' });
    expect(imageAiView(img({}), false)).toEqual({ kind: 'off' });
    expect(imageAiView(img({ ai_status: 'failed' }), true)).toEqual({ kind: 'failed' });
    expect(imageAiView(img({ ai_status: 'skip', skip_reason: 'consent' }), true)).toEqual({ kind: 'off' });
    expect(imageAiView(img({ ai_status: 'skip', skip_reason: 'other' }), true)).toEqual({ kind: 'other' });
    expect(imageAiView(img({ ai_status: 'done', ai_desc: '一张收据', ai_tags: ['收据', '', 3, '영수증'] }), true)).toEqual({ kind: 'seen', desc: '一张收据', tags: ['收据', '영수증'] });
    expect(imageAiView(img({ ai_status: 'done', ai_desc: '' }), true)).toBeNull();
    expect(imageAiView(img({ ai_status: 'skip', skip_reason: 'vault_off' }), true)).toBeNull();
    expect(imageAiView(img({ bucket: 'vault-images', ai_status: 'failed' }), true)).toBeNull();
    expect(imageAiView(img({ deleted_at: 5, ai_status: 'failed' }), true)).toBeNull();
    expect(imageAiView(undefined, true)).toBeNull();
  });
});

describe('retryAiCall：和 fileCheck 共用一份请求', () => {
  it('发 {action: retry_ai, kind: image, id}，回 ai_status；404 归 gone、回包不对归 retry', async () => {
    const real = await vi.importActual<FileCheckApi>('../data/file-check-api.ts');
    const bodies: unknown[] = [];
    const reply: Response[] = [
      new Response(JSON.stringify({ ai_status: 'pending' }), { status: 200 }),
      new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
      new Response(JSON.stringify({ ai_status: 'weird' }), { status: 200 }),
    ];
    const d = {
      accessToken: async () => 'jwt', base: 'http://x/functions/v1', anonKey: 'anon',
      fetch: (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return reply.shift() ?? new Response(null, { status: 500 });
      }) as unknown as FileCheckApiNs.CheckDeps['fetch'],
    };
    expect(await real.retryAiCall(ID, d)).toEqual({ ok: true, ai_status: 'pending' });
    expect(await real.retryAiCall(ID, d)).toEqual({ ok: false, kind: 'gone', code: 'not_found' });
    expect(await real.retryAiCall(ID, d)).toEqual({ ok: false, kind: 'retry', code: 'bad_response' });
    expect(bodies[0]).toEqual({ action: 'retry_ai', kind: 'image', id: ID });
  });
});

describe('ImageAiStatus', () => {
  beforeEach(() => {
    lines.length = 0;
    retryAiCall.mockReset();
    navigate.mockClear();
    aiOn(true);
  });
  afterEach(cleanup);

  it('识别中：一行小字，没有按钮', () => {
    collections['note_images'] = [img({})];
    render(<ImageAiStatus id={ID} />);
    expect(screen.getByTestId(`img-ai-${ID}`).dataset['ai']).toBe('pending');
    expect(screen.getByText('识别中 · 几分钟内好，好了就能按意思找到')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('AI 没开：还是 pending 也显示“没交给 AI”，“去打开”进设置 › 语音与 AI、记日志', () => {
    aiOn(false);
    collections['note_images'] = [img({})];
    render(<ImageAiStatus id={ID} />);
    expect(screen.getByText('没交给 AI · AI 没打开或你没同意，这张图不能按意思找')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去打开' }));
    expect(navigate).toHaveBeenCalledWith('settings', 'ai');
    expect(lines).toEqual(['att ai open']);
  });

  it('没识别：“重新识别”调 file-check，回 pending 以后先按识别中显示；日志只记状态', async () => {
    collections['note_images'] = [img({ ai_status: 'failed' })];
    retryAiCall.mockResolvedValue({ ok: true, ai_status: 'pending' });
    render(<ImageAiStatus id={ID} />);
    expect(screen.getByText('没识别 · 试了 3 次没成功')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重新识别' })));
    expect(retryAiCall).toHaveBeenCalledWith(ID);
    expect(screen.getByTestId(`img-ai-${ID}`).dataset['ai']).toBe('pending');
    expect(lines).toEqual(['att ai retry ok=1 status=pending']);
  });

  it('重新识别没连上：出一行提示，按钮还在', async () => {
    collections['note_images'] = [img({ ai_status: 'failed' })];
    retryAiCall.mockResolvedValue({ ok: false, kind: 'retry', code: 'network' });
    render(<ImageAiStatus id={ID} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重新识别' })));
    expect(screen.getByRole('alert').textContent).toBe('这次没连上，稍后再试一次');
    expect(screen.getByRole('button', { name: '重新识别' })).toBeTruthy();
    expect(lines).toEqual(['att ai retry ok=0 kind=retry code=network']);
  });

  it('识别好了：编辑器里什么都不出（线框“好了就消失”；描述和标签在看图页）', () => {
    collections['note_images'] = [img({ ai_status: 'done', ai_desc: '一本护照的首页', ai_tags: ['证件', '신분증'] })];
    const { container } = render(<ImageAiStatus id={ID} />);
    expect(container.childElementCount).toBe(0);
  });

  it('隐私记的图、找不到的行：什么都不出', () => {
    collections['note_images'] = [img({ bucket: 'vault-images', ai_status: 'failed' })];
    const { container } = render(<ImageAiStatus id={ID} />);
    expect(container.childElementCount).toBe(0);
  });
});

describe('ImageViewer 看图页', () => {
  const ID2 = '0199a000-0000-7000-8000-000000000002';
  const ID3 = '0199a000-0000-7000-8000-000000000003';
  const ids = [ID, ID2, ID3];
  beforeEach(() => {
    lines.length = 0;
    aiOn(true);
    if (!document.getElementById('root')) document.body.append(Object.assign(document.createElement('div'), { id: 'root' }));
    collections['note_images'] = [img({ ai_status: 'done', ai_desc: '一本护照的首页', ai_tags: ['证件', '신분증'] }), img({ id: ID2 }), img({ id: ID3, ai_status: 'failed' })];
  });
  afterEach(cleanup);
  const open = (start: number, onClose = vi.fn()) => {
    const from = document.createElement('button');
    document.body.append(from);
    const r = render(<ImageViewer ids={ids} start={start} back={from} onClose={onClose} render={(id) => <i data-testid="pic">{id}</i>} />);
    return { from, onClose, r };
  };
  const count = () => screen.getByTestId('img-view-count');

  it('打开：焦点在关闭按钮，计数“1 / 3”，识别好的这张底部有 AI 看到的（描述、中韩标签、说明）', () => {
    open(0);
    expect(document.activeElement).toBe(screen.getByTestId('img-view-close'));
    expect(count().textContent).toBe('1 / 3');
    // 看得见的“1 / 3”读屏不念，念视觉隐藏 live 区里的“第 1 张，共 3 张”
    expect(count().getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('img-view-count-sr').textContent).toBe('第 1 张，共 3 张');
    expect(screen.getByTestId('img-view-count-sr').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('img-view-close').getAttribute('aria-label')).toBe('关闭');
    // 后面的 #root 设了 inert，关了去掉
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(true);
    const card = screen.getByTestId(`img-view-ai-${ID}`);
    expect(card.textContent).toContain('AI 看到的');
    expect(card.textContent).toContain('一本护照的首页');
    expect(screen.getAllByRole('listitem').map((x) => x.textContent)).toEqual(['证件', '신분증']);
    expect(card.textContent).toContain('只写是什么东西，不抄号码');
    expect(screen.queryByRole('button', { name: '⋯' })).toBeNull();
    expect(lines).toContain('att view i=1/3');
  });

  it('左右键、两边按钮、横滑换张，计数跟着变；没识别好的那张不出卡片；到头不绕回', () => {
    open(0);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(count().textContent).toBe('2 / 3');
    expect(screen.getByTestId('pic').textContent).toBe(ID2);
    expect(screen.queryByText('AI 看到的')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(count().textContent).toBe('3 / 3');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(count().textContent).toBe('3 / 3');
    const stage = screen.getByTestId('img-view-stage');
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, isPrimary: true });
    fireEvent.pointerUp(stage, { clientX: 220, clientY: 110, isPrimary: true });
    expect(count().textContent).toBe('2 / 3');
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, isPrimary: true });
    fireEvent.pointerUp(stage, { clientX: 120, clientY: 300, isPrimary: true });
    expect(count().textContent).toBe('2 / 3');
    fireEvent.click(screen.getByRole('button', { name: '上一张' }));
    expect(count().textContent).toBe('1 / 3');
    expect(screen.getByText('AI 看到的')).toBeTruthy();
    expect(lines).toEqual(['att view i=1/3', 'att view i=2/3', 'att view i=3/3', 'att view i=2/3', 'att view i=1/3']);
  });

  it('Esc 和 ✕ 都关；关上后焦点回到打开它的元素', () => {
    const { from, onClose } = open(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('img-view-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => l === 'att view close')).toHaveLength(2);
    cleanup();
    expect(document.activeElement).toBe(from);
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(false);
  });

  it('带修饰键（Alt+← 后退）、输入法组字的左右键不换张；右键拖、非主指针不算横滑', () => {
    open(1);
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'ArrowRight', isComposing: true });
    expect(count().textContent).toBe('2 / 3');
    const stage = screen.getByTestId('img-view-stage');
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, button: 2, isPrimary: true });
    fireEvent.pointerUp(stage, { clientX: 300, clientY: 100, isPrimary: true });
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, button: 0, isPrimary: false });
    fireEvent.pointerUp(stage, { clientX: 300, clientY: 100, isPrimary: false });
    expect(count().textContent).toBe('2 / 3');
  });

  it('图增删时看着的这张不跳：前面插一张、删掉这张夹到范围里、全删了就关', () => {
    const { onClose, r } = open(1);
    const rerender = (list: string[]) => r.rerender(<ImageViewer ids={list} start={1} back={null} onClose={onClose} render={(id) => <i data-testid="pic">{id}</i>} />);
    const NEW = '0199a000-0000-7000-8000-000000000009';
    rerender([NEW, ID, ID2, ID3]);
    expect(count().textContent).toBe('3 / 4');
    expect(screen.getByTestId('pic').textContent).toBe(ID2);
    rerender([NEW, ID, ID3]);
    expect(count().textContent).toBe('2 / 3');
    rerender([ID3]);
    expect(count().textContent).toBe('1 / 1');
    expect(screen.getByTestId('pic').textContent).toBe(ID3);
    expect(onClose).not.toHaveBeenCalled();
    rerender([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('只有一张：不画换张按钮', () => {
    render(<ImageViewer ids={[ID]} start={0} back={null} onClose={vi.fn()} render={() => null} />);
    expect(count().textContent).toBe('1 / 1');
    expect(screen.queryByRole('button', { name: '下一张' })).toBeNull();
  });
});
