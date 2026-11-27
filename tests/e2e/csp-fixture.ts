// CSP 报错收集（架构 1.3 B0 验收：带 CSP 跑一页，控制台出现任何 CSP 报错就失败）
// 两路同时收：页面的 securitypolicyviolation 事件、浏览器控制台里的 CSP 报错文字
import { test as base, expect, type Page } from '@playwright/test';

export interface Violation {
  directive: string;
  blocked: string;
  source: string;
  /** webkit 新建 <select> 时内核自己报的那一条（见下面 WEBKIT_SELECT 的说明）；只有这种才会被放过 */
  webkitSelect?: boolean;
}

declare global {
  interface Window {
    __csp?: Violation[];
    /** 建过几个 <select>（只在 webkit 里计数，createElement 时同步加一） */
    __cspSelects?: number;
    /** 本注入脚本自己的 URL：包了 createElement 以后，建 select 的违规来源记成它（只在 webkit 里取） */
    __cspOwn?: string;
  }
}

/**
 * WebKit 内核的误报（11-05 查明，B2-代码审查-FA7底栏外壳.md 第四节；bug 草稿 docs/03-评审/B2/B2-WebKit-bug草稿-select-CSP误报.md）：
 * 在 style-src 不含 'unsafe-inline' 的页面里，WebKit 每 createElement('select') 一次就报一条 style-src-attr（blocked = inline），
 * 只建不挂进文档也报；Chromium 不报；有没有 CSP 时 select 的尺寸、计算样式一样（页面没有任何内联样式被拦）。
 * 做法：webkit 下包一层 Document.prototype.createElement，建 select 时同步计数，再调原生的。包了以后，WebKit 把这条违规的来源
 * （sourceFile）记成本注入脚本自己（调用栈最上面那一帧），所以放过的条件同时满足才算：webkit、violatedDirective = style-src-attr、
 * blockedURI = inline、来源正好是本注入脚本（运行时从调用栈取的 URL，页面自己的脚本和 setAttribute('style') 都不会是它）、
 * 而且条数不超过建过的 <select> 个数（一个 select 只抵一条）。别的内联样式违规照样判失败。
 * 为什么在“建”的时候数、不等挂进文档（11-05 修 4 并发偶发失败）：React DOM 在渲染阶段建 select，WebKit 当场就报；
 * 这棵树要到提交时才插进文档，机器忙时两者隔得久（用例最后只等到 URL 变了就收尾，编辑页还没提交），按“挂进文档的个数”配就配不上。
 * 建的时候计数是同步的，总在违规事件之前。
 * 控制台文字（“Refused to apply a stylesheet …”）按建过的 select 个数扣：控制台消息可能比违规事件先到 Node，不能按“已标出的事件条数”扣。
 * 真正的内联样式违规照样有 securitypolicyviolation 事件，由事件那一路判失败。最小复现在 csp-webkit-select.spec.ts（test.fail）
 * 整条用例累计（11-07 修，B2-UI-a V5 查明）：注入脚本每载入一次文档就重跑，原来 __cspSelects、__csp 跟着从 0 重来，控制台报错却是整条用例累计的；
 * 一条用例进过两个带 select 的页面（例如先待办编辑页、再整页载入日程编辑页），前一页的报错就没有 select 抵，被当成真违规；前一页的违规事件也丢了。
 * 现在离开文档（pagehide，导航、刷新都会触发）时把累计到的 select 个数、违规事件、本注入脚本 URL 存进 sessionStorage（CARRY_KEY），
 * 下一个文档的注入脚本一开头读出来、删掉、接着累计；从后退缓存恢复（pageshow persisted）时同样读回。于是页面里的快照是整条用例的累计数，
 * 和控制台同一个口径。放过条件不变：一个 select 只抵一条，只抵来源是本注入脚本的 style-src-attr / inline；真违规事件也一并带过来，照样判失败。
 * 已知限制（两条都只会多报、不会漏判真违规的控制台那一路）：
 * ① iframe：注入脚本在每个 frame 里各跑一份，各数各的，但收尾只读主 frame（page.evaluate）；控制台却收全部 frame 的报错。
 *    iframe 里建的 select 不进额度，它的误报会被判成真违规；iframe 里的违规事件也看不到，只能靠控制台那一路。本站页面目前没有 iframe。
 * ② 跨源导航：sessionStorage 按源分开，跳到别的源（再跳回来）时累计数带不过去，退回成“只按本文档数”，和修之前一样。用例都在同源里跑。
 */
export const CARRY_KEY = '__lemo_csp_carry';
const WEBKIT_SELECT_CONSOLE = /^\[error\] Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive/;

const CSP_TEXT = /Content[- ]Security[- ]Policy|Refused to (apply|load|execute|connect|frame)/i;

export interface CspWatch {
  /** 页面事件收到的违规（webkit 建 select 的误报已扣掉） */
  violations(): Promise<Violation[]>;
  /** 全部违规，webkit 建 select 的那几条带 webkitSelect: true（只给 csp-webkit-select.spec.ts 核对放过规则用） */
  allViolations(): Promise<Violation[]>;
  /** 控制台里的 CSP 报错 */
  consoleErrors: string[];
  /** 本用例预期会有违规（对照组），收尾时不判失败 */
  expectViolations(): void;
  /** 整条用例累计建过的 select 个数（只 webkit 计数；给 csp-webkit-select.spec.ts 核对累计口径用） */
  selects(): Promise<number>;
}

/** 控制台 CSP 报错里扣掉 webkit 建 select 的误报以后剩下的：建过几个 select，就最多扣掉几条同样文字的报错（收尾判失败和测试共用） */
export function consoleRest(consoleErrors: readonly string[], selects: number): string[] {
  let skip = selects;
  return consoleErrors.filter((m) => !(skip > 0 && WEBKIT_SELECT_CONSOLE.test(m) && skip-- > 0));
}

/** 读全部违规，并把 webkit 建 select 的误报标出来：符合条件的按先后配对，最多配 __cspSelects 条 */
async function readState(page: Page, webkit: boolean): Promise<{ list: Violation[]; selects: number }> {
  const { list, selects, own } = await page.evaluate(() => ({ list: window.__csp ?? [], selects: window.__cspSelects ?? 0, own: window.__cspOwn ?? '' }));
  let budget = webkit && own !== '' ? selects : 0;
  return {
    selects: webkit ? selects : 0,
    list: list.map((v) => {
      if (budget > 0 && v.directive === 'style-src-attr' && v.blocked === 'inline' && v.source === own) {
        budget -= 1;
        return { ...v, webkitSelect: true };
      }
      return v;
    }),
  };
}

const readViolations = async (page: Page, webkit: boolean): Promise<Violation[]> => (await readState(page, webkit)).list;

/** 判失败用的违规：webkit 建 select 的那一种去掉 */
const counted = (v: Violation[]): Violation[] => v.filter((x) => !x.webkitSelect);

export const test = base.extend<{ csp: CspWatch }>({
  csp: [
    async ({ page, browserName }, use) => {
      const webkit = browserName === 'webkit';
      await page.addInitScript(([webkit, key]: readonly [boolean, string]) => {
        window.__csp = [];
        window.__cspSelects = 0;
        if (webkit) {
          // 本注入脚本的 URL：调用栈第一行形如 @web-inspector://bootstrap.js:617:52，去掉开头的函数名和 @、末尾的行列号
          window.__cspOwn = ((new Error().stack ?? '').split('\n')[0] ?? '').replace(/^[^@]*@/, '').replace(/:\d+:\d+$/, '');
          // 建 select 时同步计数（React DOM 建元素走的就是 ownerDocument.createElement）
          const ce = Document.prototype.createElement;
          Document.prototype.createElement = function (this: Document, tag: string, opts?: ElementCreationOptions) {
            if (String(tag).toLowerCase() === 'select') window.__cspSelects = (window.__cspSelects ?? 0) + 1;
            return ce.call(this, tag, opts) as HTMLElement;
          } as typeof Document.prototype.createElement;
        }
        // 整条用例累计（见文件头）：接上前一个文档存下的数；前一个文档的注入脚本 URL 若不同，它记下的来源换成本文档的，配对口径不变
        const load = (): void => {
          try {
            const raw = sessionStorage.getItem(key);
            if (raw === null) return;
            sessionStorage.removeItem(key);
            const c = JSON.parse(raw) as { selects: number; list: Violation[]; own: string };
            const own = window.__cspOwn ?? '';
            window.__csp = c.list.map((v) => (c.own !== '' && v.source === c.own ? { ...v, source: own } : v));
            window.__cspSelects = c.selects;
          } catch {
            // sessionStorage 不可用（跨源、隐私模式）：只能按本文档数，和修之前一样
          }
        };
        load();
        addEventListener('pagehide', () => {
          try {
            sessionStorage.setItem(key, JSON.stringify({ selects: window.__cspSelects ?? 0, list: window.__csp ?? [], own: window.__cspOwn ?? '' }));
          } catch {
            // 同上
          }
        });
        addEventListener('pageshow', (e) => {
          if (e.persisted) load();
        });
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__csp?.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile });
        }, true);
      }, [webkit, CARRY_KEY] as const);
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (CSP_TEXT.test(m.text())) consoleErrors.push(`[${m.type()}] ${m.text()}`);
      });
      let expected = false;
      await use({
        violations: async () => counted(await readViolations(page, webkit)),
        allViolations: () => readViolations(page, webkit),
        consoleErrors,
        expectViolations: () => {
          expected = true;
        },
        selects: async () => (await readState(page, webkit)).selects,
      });
      if (!expected) {
        // 读页面计数是一张“那一刻”的快照（11-07 在 CI 同款 Linux webkit 镜像里查明）：用例刚等到地址变成编辑页就收尾，编辑页还在渲染，
        // page.evaluate 在页面里跑完以后又建了 select，它们的控制台报错比 evaluate 的结果先到 Node，于是控制台条数 > 快照里的 select 个数，
        // 多出来的被当成真违规（b2-readonly-rows“今天页”、b2-tabbar“＋”偶发失败）。读的过程中又来了控制台报错就再读一次，
        // 直到读的那段时间里没有新报错：这时已到的每条报错都在快照之前发出，对应的 select 都已计数。放过条件不变（一个 select 只抵一条）
        const read = async (): Promise<{ list: Violation[]; selects: number }> =>
          page.isClosed() ? { list: [], selects: 0 } : await readState(page, webkit).catch(() => ({ list: [], selects: 0 }));
        let seen = consoleErrors.length;
        let { list: all, selects } = await read();
        for (let i = 0; i < 5 && consoleErrors.length !== seen; i += 1) {
          seen = consoleErrors.length;
          ({ list: all, selects } = await read());
        }
        // 控制台：webkit 建过几个 select，就最多扣掉几条同样文字的报错（不按已标出的事件条数扣，见文件头）
        // 控制台文字是通用的，这样扣可能顺带扣掉一条同文字的真违规；不会漏判：真违规的 securitypolicyviolation 事件不在扣除之列，下面事件那一路照样拦（代码审查 FA-7 第八节 L9）
        const rest = consoleRest(consoleErrors, selects);
        expect(counted(all), 'securitypolicyviolation 事件').toEqual([]);
        expect(rest, '控制台 CSP 报错').toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
