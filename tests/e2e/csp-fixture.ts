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
 */
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
      await page.addInitScript((webkit: boolean) => {
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
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__csp?.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile });
        }, true);
      }, webkit);
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
      });
      if (!expected) {
        const { list: all, selects } = page.isClosed() ? { list: [], selects: 0 } : await readState(page, webkit).catch(() => ({ list: [], selects: 0 }));
        // 控制台：webkit 建过几个 select，就最多扣掉几条同样文字的报错（不按已标出的事件条数扣，见文件头）
        // 控制台文字是通用的，这样扣可能顺带扣掉一条同文字的真违规；不会漏判：真违规的 securitypolicyviolation 事件不在扣除之列，下面事件那一路照样拦（代码审查 FA-7 第八节 L9）
        let skip = selects;
        const rest = consoleErrors.filter((m) => !(skip > 0 && WEBKIT_SELECT_CONSOLE.test(m) && skip-- > 0));
        expect(counted(all), 'securitypolicyviolation 事件').toEqual([]);
        expect(rest, '控制台 CSP 报错').toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
