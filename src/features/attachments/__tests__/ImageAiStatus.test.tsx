// @vitest-environment jsdom
// B4b-2 识图：随手记图片下面的识别状态（线框 sAIst）。data/image-ai.ts 的状态判定 + ui/ImageAiStatus.tsx 的显示和两个按钮
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

  it('识别好了：AI 看到的 + 描述 + 标签', () => {
    collections['note_images'] = [img({ ai_status: 'done', ai_desc: '一本护照的首页', ai_tags: ['证件', '신분증'] })];
    render(<ImageAiStatus id={ID} />);
    expect(screen.getByText('AI 看到的')).toBeTruthy();
    expect(screen.getByText('一本护照的首页')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((x) => x.textContent)).toEqual(['证件', '신분증']);
  });

  it('隐私记的图、找不到的行：什么都不出', () => {
    collections['note_images'] = [img({ bucket: 'vault-images', ai_status: 'failed' })];
    const { container } = render(<ImageAiStatus id={ID} />);
    expect(container.childElementCount).toBe(0);
  });
});
