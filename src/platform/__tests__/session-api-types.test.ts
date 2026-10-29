// 删本机会话的接口没有“给不给参数决定删不删”的写法（接手清单 K6-sugg4 ②）：下面每一行都必须编不过。
// 哪天有人把参数改回可选、或加回不带参数的 clearLocalSession，npm run typecheck（tsconfig.node.json 含测试）
// 就报 TS2578“没用上的 @ts-expect-error”。shapes() 只给 tsc 看，不执行（有的会真的跳页、删会话）。
// 功能层的几处（设置页 dropLocalSession、告知页 leaveThisDevice、watchAccount 的 onSignedOut）在各自目录的测试里同样写了
import { describe, expect, it } from 'vitest';
import * as session from '../session.ts';
import { defaultExitSteps, dropSession } from '../sign-out.ts';

function shapes(): void {
  // @ts-expect-error ExitSteps 只有 clearLocalSessionIf，sid 必填
  defaultExitSteps.clearLocalSessionIf();
  // @ts-expect-error 旧的 clearLocalSession(onlyIf?) 已经没有了
  defaultExitSteps.clearLocalSession();
  // @ts-expect-error dropSession 的 sid 必填
  dropSession(defaultExitSteps);
  // @ts-expect-error session.ts 不再导出 clearLocalSession（不管是谁都删的那个叫 clearAnyLocalSession，名字里写明）
  session.clearLocalSession();
  // @ts-expect-error clearLocalSessionIf 的 sid 必填
  session.clearLocalSessionIf();
  // @ts-expect-error 传 undefined 也不行（不会悄悄退回“直接删”）
  session.clearLocalSessionIf(undefined);
  // @ts-expect-error goToAuth('removed') 必须带删掉的那个 session_id
  session.goToAuth('removed');
  // 这些是对的写法
  session.clearLocalSessionIf(null);
  session.goToAuth('removed', 's1');
  session.goToAuth('disabled');
  session.goToAuth();
}

describe('删本机会话的接口（K6-sugg4 ②）', () => {
  it('不给 session_id 的调用编不过（见 shapes 里的 @ts-expect-error，由 typecheck 检查）', () => {
    expect(typeof shapes).toBe('function');
  });
});
