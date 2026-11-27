"""维护 需求记录.md 的“影响”列，并核对“状态”列。

用法：python build/req_index.py          # 重写“影响”列，再做核对
      python build/req_index.py --check  # 只核对，不改文件（有问题退出码 1）

“影响”列由脚本生成：在视觉稿、定稿线框、架构设计、测试用例 v4（有了以后）里搜 R 号，
列出出现的位置（架构写节号）。不要手改这一列，改了下次运行会被覆盖。
“状态”列手写：空 = 有效；“部分取代 ← R-x”或“已被取代 ← R-x”。
核对规则：某条的“结果”里写了“取代 R-x”，R-x 的“状态”就不能是空的。
"""
import pathlib
import re
import sys
sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
REQ = ROOT / "docs/01-需求/需求记录.md"
HEAD = "| 编号 | 日期 | 用户需求 | 结果 | 状态 | 影响 | 对应版本 |"
SOURCES = [
    ("视觉稿", "docs/02-设计/皮肤-v4/皮肤视觉稿.html", False),
    ("线框", "docs/02-设计/草图-v4/线框-v4-定稿.html", False),
    ("架构", "docs/10-架构/架构设计-v4.md", True),
]


def rnum(r):
    return int(r.split("-")[1])


def pattern(n):
    return re.compile(r"R-0*%d(?!\d)" % n)


def sources():
    out = []
    for name, rel, by_section in SOURCES:
        p = ROOT / rel
        if p.exists():
            out.append((name, p.read_text(encoding="utf-8").splitlines(), by_section))
    for p in sorted((ROOT / "docs/06-测试").glob("测试用例-v4*.md")):
        out.append(("测试用例", p.read_text(encoding="utf-8").splitlines(), False))
    return out


def impact(n, srcs):
    pat, parts = pattern(n), []
    for name, lines, by_section in srcs:
        if not by_section:
            if any(pat.search(l) for l in lines):
                parts.append(name)
            continue
        secs, cur = [], ""
        for l in lines:
            m = re.match(r"#{2,4} (\S+)", l)
            if m:
                cur = m.group(1)
            elif pat.search(l) and cur and cur not in secs:
                secs.append(cur)
        if secs:
            parts.append("架构 " + "、".join(secs[:5]) + (f" 等 {len(secs)} 节" if len(secs) > 5 else ""))
    return " · ".join(parts) or "—"


def main():
    check_only = "--check" in sys.argv
    lines = REQ.read_text(encoding="utf-8").splitlines()
    srcs = None if check_only else sources()
    rows, problems = {}, []
    for i, l in enumerate(lines):
        if l.startswith("| 编号 |"):
            lines[i] = HEAD
        elif l.startswith("|---") and i > 0 and lines[i - 1] == HEAD:
            lines[i] = "|---|---|---|---|---|---|---|"
        elif l.startswith("| R-"):
            c = [x.strip() for x in l.split("|")[1:-1]]
            if len(c) == 5:  # 旧格式：补上 状态、影响
                c = c[:4] + ["", ""] + c[4:]
            if len(c) != 7:
                problems.append(f"{c[0]}：列数不对（{len(c)}）")
                continue
            if not check_only:
                c[5] = impact(rnum(c[0]), srcs)
            rows[c[0]] = (i, c)
            lines[i] = "| " + " | ".join(c) + " |"
    for r, (_, c) in rows.items():
        for m in re.finditer(r"取代\s*(?:了)?\s*(R-\d+)", c[3]):
            t = m.group(1)
            t = next((k for k in rows if rnum(k) == rnum(t)), t)
            if t in rows and t != r and not rows[t][1][4]:
                problems.append(f"{r} 写了“取代 {t}”，但 {t} 的状态是空的")
    if not check_only:
        REQ.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    for p in problems:
        print("⚠", p)
    print(f"需求 {len(rows)} 条；问题 {len(problems)} 个")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
