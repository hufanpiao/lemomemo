// i18n-exempt: 解析词表
// 本机规则的拆分（B3 任务单 BE-2；架构 5.1“拆分”；AI 句库 Z14、Z22、Z24～Z27、K24～K26、M12、M16～M18；TC-B3-15、63）：
//   保守：宁可不拆，也别把一件事拆成两件（单件被拆成多条全库最多 2 句，TC-B3-15）。拆错了提示条有“拆错了，合并成一条”。
//   • 按“，, ； ; 。 换行”和“然后 / 还有 / 그리고 / 그 다음에”拆；
//   • 一段里有顿号“、”的（列举几件事）按顿号拆，最后一段再按“和”拆一次（“完成报价单、整理客户资料和发送邮件”→ 3 件）；
//     顿号前面紧挨着“和 / 跟 / 与 / 同 + 1～3 个字”的是在列人名（“和老李、小王一起过方案”），不拆；
//     没有顿号时“和”一律不拆（“买牛奶和鸡蛋”是 1 件）；
//   • 韩文连接词尾“-고”后面这一段自己带了时刻的才拆（“치과 가고 11시에 정산”）；“일 끝나고 헬스장 가기”“우유 사고 交电费”不拆（后者没把握，交给 AI）。
//   拆出来的空段丢掉；只有日子或时刻、没有事由的段由调用方（parse-split.ts）并进下一段，合起来的那段判没把握（代码审 M3）。

const SEP_RE = /[，,；;。\n]|然后|还有|그리고|그\s*다음에?/;

/** 拆句用的同一套分隔（带 g，每次新建一个）：打字条只拿它在原话里找等确认那条的位置（src/features/plus/data/type-flow.ts），不另抄一份词（A20） */
export function clauseSeparators(): RegExp {
  return new RegExp(SEP_RE.source, 'g');
}
const KO_GO_RE = /(?<=[가-힣])고\s+(?=[^，,]*?\d{1,2}\s*(?:시|点|:))/;

export function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(SEP_RE)) {
    for (const part of splitList(chunk)) {
      for (const p of part.split(KO_GO_RE)) {
        if (p.trim()) out.push(p.trim());
      }
    }
  }
  return out;
}

function splitList(chunk: string): string[] {
  if (!chunk.includes('、')) return [chunk];
  const pieces = chunk.split('、');
  // 列人名：前一段末尾是“和 / 跟 / 与 / 同 + 1～3 个字”，不按顿号拆
  if (pieces.slice(0, -1).some((p) => /[和跟与同][^、\s]{1,3}$/.test(p.trim()))) return [chunk];
  const last = pieces.pop() ?? '';
  const i = last.lastIndexOf('和');
  if (i > 0 && i < last.length - 1) pieces.push(last.slice(0, i), last.slice(i + 1));
  else pieces.push(last);
  return pieces;
}
