// 门面和 motion 冷渲染的 DOM 逐属性一致（R-354 做法 A，方案第 2 节、风险 K1；G10“启动不跳”的关键）：
// 首屏上画的是门面（./Appear.tsx 等，只依赖 react）；原来首屏画的是 motion 实现在功能包没到时的冷渲染。
// 同一份 props 两边各画一次，按元素逐个比：标签、每个属性（顺序不算）、内联样式的每一项，必须完全一样。
// 覆盖：Appear 的六种 kind（带不带 className）、AppearList 三种外壳、AppearItem 三种标签（className、data-*、aria-labelledby、data-state）、
// SharedLayout；“减少动态效果”开和关各一遍
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as facade from '../components.ts';
import { loadMotionFeatures, resetMotionFeaturesForTest } from '../features.ts';
import * as impl from '../motion-impl.tsx';
import { presets, type AppearKind } from '../presets.ts';

afterEach(() => {
  cleanup();
  resetMotionFeaturesForTest();
  delete document.documentElement.dataset['rm'];
});

type Kit = Pick<typeof facade, 'Appear' | 'AppearList' | 'AppearItem' | 'SharedLayout'>;

/** 元素 → 规范化的字符串：属性排序，style 拆成各项排序 */
function norm(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return JSON.stringify(n.textContent);
  if (!(n instanceof HTMLElement)) return '';
  const attrs = [...n.attributes]
    .filter((a) => a.name !== 'style')
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort();
  const style = [...n.style].map((k) => `${k}:${n.style.getPropertyValue(k)}`).sort();
  const kids = [...n.childNodes].map(norm).join(',');
  return `<${n.tagName.toLowerCase()} ${attrs.join(' ')} style{${style.join(';')}}>[${kids}]`;
}

/** 画一次、立刻取 DOM（motion 的 LazyMotion 在 effect 里开始下载，取 DOM 在那之前）；
 *  等那次下载落定以后再回到“没下载”，免得它晚到、把下一次冷渲染变成热的 */
async function snap(tree: ReactNode): Promise<string> {
  const { container } = render(<>{tree}</>);
  const out = [...container.childNodes].map(norm).join('\n');
  cleanup();
  await loadMotionFeatures();
  resetMotionFeaturesForTest();
  return out;
}

const KINDS = Object.keys(presets) as AppearKind[];

function sample(k: Kit): ReactNode {
  const { Appear, AppearList, AppearItem, SharedLayout } = k;
  return (
    <>
      {KINDS.map((kind) => (
        <Appear key={kind} kind={kind} show className={`c-${kind}`}>
          <b>{kind}</b>
        </Appear>
      ))}
      <Appear kind="toast" show>
        <i>no class</i>
      </Appear>
      <Appear kind="toast" show={false}>
        <i>hidden</i>
      </Appear>
      <AppearList as="ul" className="L" data-testid="list">
        <AppearItem key="a" as="li" className="I" data-id="a" data-state="done">
          a
        </AppearItem>
        <AppearItem key="b" as="li">
          b
        </AppearItem>
      </AppearList>
      <AppearList as="ol">
        <AppearItem key="c" as="div" data-x="1">
          c
        </AppearItem>
      </AppearList>
      <AppearList as="div" className="G">
        <AppearItem key="s" as="section" aria-labelledby="h1" className="S">
          <h2 id="h1">t</h2>
        </AppearItem>
      </AppearList>
      <SharedLayout id="k" className="Q">
        q
      </SharedLayout>
      <SharedLayout id="k2">q2</SharedLayout>
    </>
  );
}

describe('门面和 motion 冷渲染 DOM 一致（R-354 K1）', () => {
  for (const rm of [false, true]) {
    it(`减少动态效果${rm ? '开' : '关'}`, async () => {
      if (rm) document.documentElement.dataset['rm'] = '1';
      const a = await snap(sample(facade));
      const b = await snap(sample(impl));
      expect(a.length).toBeGreaterThan(100);
      expect(a).toBe(b);
    });
  }
});
