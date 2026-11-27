"""TC-B7a-17：从 测试用例-v4.md 各张用例表的“级别”一列生成 P0 勾选表（15.4 上线门槛），并核对条数。

用法：python -I build/p0_list.py                 # 把 P0 勾选表打印到屏幕（Markdown，每条一行“- [ ] 编号　依据”）
      python -I build/p0_list.py --out <文件>    # 写进文件（B7 验收记录里逐项打勾用；文件放哪由调用的人定）
      python -I build/p0_list.py --check         # 只核对，不输出勾选表（unit.yml 跑这个，有问题退出码 1）

读哪些表：表头第一列是“编号”、最后一列是“级别”的表（含 3.3 节注销用例表，它的列不同，但同样以“级别”结尾）。
核对：
  1. 每行的列数和表头一样、编号是 TC-<批>-<序号> 的写法、级别只许 P0 / P1 / P2 / —；
  2. 编号不重复；TC-DEL-* 一律 P0（第 0 节、3.3 节的规定）；
  3. 第 18 节“级别”一条里写的“P0 共 N 条”和表里数出来的一样（对不上时 CI 失败，TC-B7a-17 期望）；
     同一句里的“P1 N 条”“P2 N 条”对不上只打提醒、不失败。
只读文件，不改测试用例文档；数不对时改文档第 18 节或改对应行的级别，不改本脚本。
"""
import pathlib
import re
import sys

# 打印和 --out 写文件都用 LF（Windows 上 print 默认会换成 CRLF）
sys.stdout.reconfigure(encoding="utf-8", newline="\n")

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOC = ROOT / "docs/06-测试/测试用例-v4.md"
LEVELS = ("P0", "P1", "P2", "—")
ID_RE = re.compile(r"^TC-[A-Za-z0-9]+-[A-Za-z0-9][A-Za-z0-9_-]*$")
CELL_SPLIT = re.compile(r"(?<!\\)\|")


def cells(line):
    """一行 Markdown 表格拆成格子（不认转义的 \\|），去掉首尾的空格子"""
    parts = [c.strip() for c in CELL_SPLIT.split(line.strip())]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def plain(s):
    """去掉加粗、行内代码的标记"""
    return s.replace("**", "").replace("`", "").strip()


def parse(text):
    """返回 (rows, errors)：rows 是 [(行号, 编号, 级别, 依据)]"""
    rows, errors = [], []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        head = cells(lines[i]) if lines[i].startswith("|") else []
        if len(head) >= 2 and plain(head[0]) == "编号" and plain(head[-1]) == "级别":
            ncol = len(head)
            i += 2  # 跳过表头和分隔行
            while i < len(lines) and lines[i].startswith("|"):
                c = cells(lines[i])
                no = i + 1
                if len(c) != ncol:
                    errors.append(f"第 {no} 行：列数 {len(c)}，表头是 {ncol} 列")
                else:
                    tc, level = plain(c[0]), plain(c[-1])
                    if not ID_RE.match(tc):
                        errors.append(f"第 {no} 行：编号「{tc}」不是 TC-<批>-<序号> 的写法")
                    elif level not in LEVELS:
                        errors.append(f"第 {no} 行：{tc} 的级别「{level}」不是 {' / '.join(LEVELS)} 之一")
                    else:
                        rows.append((no, tc, level, plain(c[1]) if ncol > 2 else ""))
                i += 1
            continue
        i += 1
    return rows, errors


def stated(text):
    """第 18 节“级别”一条里写的 P0、P1、P2 条数"""
    sec = text.split("## 18.", 1)
    if len(sec) < 2:
        return None
    m = re.search(r"\*\*级别\*\*：P0 共 (\d+) 条.*?P1 (\d+) 条.*?P2 (\d+) 条", sec[1].split("\n## ", 1)[0], re.S)
    return None if not m else {"P0": int(m.group(1)), "P1": int(m.group(2)), "P2": int(m.group(3))}


def check(text):
    rows, errors = parse(text)
    if not rows:
        errors.append("一张以“编号”开头、“级别”结尾的用例表都没找到")
    seen = {}
    for no, tc, level, _ in rows:
        if tc in seen:
            errors.append(f"第 {no} 行：{tc} 和第 {seen[tc]} 行重复")
        seen.setdefault(tc, no)
        if tc.startswith("TC-DEL-") and level != "P0":
            errors.append(f"第 {no} 行：{tc} 是注销用例，级别必须是 P0（现在是 {level}）")
    count = {lv: sum(1 for r in rows if r[2] == lv) for lv in LEVELS}
    want = stated(text)
    if want is None:
        errors.append("第 18 节里没找到“**级别**：P0 共 N 条……P1 N 条……P2 N 条”这一句")
    else:
        # TC-B7a-17 卡的是 P0：对不上就失败；P1、P2 只提醒（第 18 节的数由 QA 维护，晚一步更新不挡 CI）
        for lv, n in want.items():
            if count[lv] != n:
                msg = f"{lv}：表里“级别”一列数出来 {count[lv]} 条，第 18 节写的是 {n} 条"
                if lv == "P0":
                    errors.append(msg)
                else:
                    print(f"p0_list：提醒：{msg}（不算失败，请 QA 更新第 18 节）")
    return rows, count, errors


def checklist(rows, count):
    out = [f"# P0 勾选表（TC-B7a-17，由 build/p0_list.py 从 测试用例-v4.md 生成，共 {count['P0']} 条）", ""]
    for _, tc, level, basis in rows:
        if level == "P0":
            short = basis if len(basis) <= 60 else basis[:60] + "…"
            out.append(f"- [ ] {tc}　{short}".rstrip())
    return "\n".join(out) + "\n"


def arg(argv, name):
    if name not in argv:
        return None
    k = argv.index(name)
    return argv[k + 1] if k + 1 < len(argv) else ""


def main(argv):
    # --doc 只给测试用（tests/build/p0-list.test.ts 拿小样例文档跑）
    doc = arg(argv, "--doc")
    if doc == "":
        print("p0_list：--doc 后面要写文件路径")
        return 2
    text = (pathlib.Path(doc) if doc else DOC).read_text(encoding="utf-8")
    rows, count, errors = check(text)
    for e in errors:
        print(f"p0_list：{e}")
    if errors:
        return 1
    summary = f"P0 {count['P0']} 条（和第 18 节一致）、P1 {count['P1']} 条、P2 {count['P2']} 条、功能用例 {count['—']} 条"
    if "--check" in argv:
        print(f"p0_list：{summary}")
        return 0
    text_out = checklist(rows, count)
    out = arg(argv, "--out")
    if out == "":
        print("p0_list：--out 后面要写文件路径")
        return 2
    if out:
        pathlib.Path(out).write_text(text_out, encoding="utf-8", newline="\n")
        print(f"p0_list：已写 {out}（{summary}）")
    else:
        sys.stdout.write(text_out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
