// arch-fixture: expect=TS7006,TS2532,TS2375,TS4114,TS18046 rule=T1
// 违规（架构 2.3 T1；QA D-06）：五个严格选项各违反一处，每一处都要编译不过
//   strict（noImplicitAny）→ TS7006；noUncheckedIndexedAccess → TS2532；exactOptionalPropertyTypes → TS2375；
//   noImplicitOverride → TS4114；useUnknownInCatchVariables → TS18046

export const implicitAny = (x) => x;

const list: number[] = [1];
export const fixed = list[0].toFixed();

export const opt: { a?: string } = { a: undefined };

class Base {
  run(): void {}
}
export class Child extends Base {
  run(): void {}
}

export function caught(): string {
  try {
    return '';
  } catch (e) {
    return e.message;
  }
}
