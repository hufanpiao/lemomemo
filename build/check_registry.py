"""核对 文件登记册.md 与实际文件是否一一对应。

用法：python build/check_registry.py
读取登记册里每个表格行的第一列（路径），与项目内实际文件比较，
列出“有文件没登记”和“登记了但文件不存在”的条目。全部对上时退出码为 0。
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def registered_paths():
    text = (ROOT / "文件登记册.md").read_text(encoding="utf-8")
    paths = set()
    for line in text.splitlines():
        if line.startswith("## 项目外"):
            break
        if not line.startswith("|") or line.startswith("|---") or line.startswith("| 路径"):
            continue
        cell = line.split("|")[1].strip()
        m = re.match(r"\[([^\]]+)\]\(", cell)
        cell = m.group(1) if m else cell.strip("`")
        # 没有扩展名的文件（VERSION、src/_headers）只要确实是文件也算登记；没有扩展名又不是文件的当作目录行跳过
        if cell and ("." in cell.split("/")[-1] or (ROOT / cell).is_file()):
            paths.add(cell)
    return paths


def git_files():
    """项目里的文件 = git 跟踪的 + 没被 .gitignore 忽略的新文件。
    4.0.0 起有 node_modules、dist/web、.wrangler 这些被忽略的大目录，不能再整棵树扫。"""
    res = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT, capture_output=True, check=True,
    )
    for rel in res.stdout.decode("utf-8").split("\0"):
        if rel and (ROOT / rel).is_file():  # 已删但还在暂存区的不算
            yield rel


def actual_paths():
    out = set()
    for rel in git_files():
        # data/backups/ 里是真实数据（不进 git、不登记），只登记它的 README
        if rel.startswith("data/backups/") and rel != "data/backups/README.md":
            continue
        # docs/02-设计/线上存档/ 里是发布时自动存的稿子副本（钩子生成），只登记它的 README
        if rel.startswith("docs/02-设计/线上存档/") and rel != "docs/02-设计/线上存档/README.md":
            continue
        out.add(rel)
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    reg, act = registered_paths(), actual_paths()
    missing = sorted(act - reg)
    stale = sorted(reg - act)
    print("有文件没登记：" if missing else "有文件没登记：无")
    for p in missing:
        print("  " + p)
    print("登记了但文件不存在：" if stale else "登记了但文件不存在：无")
    for p in stale:
        print("  " + p)
    sys.exit(1 if missing or stale else 0)


if __name__ == "__main__":
    main()
