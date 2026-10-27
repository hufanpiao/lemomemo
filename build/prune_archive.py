"""线上存档瘦身：docs/02-设计/线上存档/ 里每个稿子只留最近 3 份副本（R-157）。

用法：python build/prune_archive.py          # 只列出要删的
      python build/prune_archive.py --apply  # 用 git rm 删掉（删掉的仍在 git 历史里）

副本文件名是 `日期_时分秒_原文件名`（见该文件夹的 README.md），按原文件名分组、按时间排序。
还没提交进 git 的副本不删，先提交再运行。
"""
import collections
import pathlib
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = pathlib.Path(__file__).resolve().parent.parent
DIR = ROOT / "docs/02-设计/线上存档"
KEEP = 3
NAME = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{6})(?:_\d+)?_(.+)$")


def main():
    tracked = set(subprocess.run(["git", "ls-files", "-z", "--", str(DIR)], cwd=ROOT, capture_output=True,
                                 text=True, encoding="utf-8", check=True).stdout.split("\0"))
    groups = collections.defaultdict(list)
    for p in DIR.iterdir():
        m = NAME.match(p.name)
        if p.is_file() and m:
            groups[m.group(2)].append((m.group(1), p.name, p))
    drop, untracked = [], []
    for name, items in sorted(groups.items()):
        items.sort()
        for _, _, p in items[:-KEEP]:
            (drop if p.relative_to(ROOT).as_posix() in tracked else untracked).append(p)
        print(f"{name}：{len(items)} 份，留 {min(len(items), KEEP)} 份")
    for p in untracked:
        print("⚠ 还没提交，先不删：", p.name)
    print(f"要删 {len(drop)} 份")
    if "--apply" in sys.argv and drop:
        subprocess.run(["git", "rm", "-q", "--"] + [str(p) for p in drop], cwd=ROOT, check=True)
        print("已用 git rm 删除")


if __name__ == "__main__":
    main()
