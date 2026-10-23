"""版本前备份：源码 + 数据（ADR-009）。

用法：python build/backup.py <时机>      例如：python build/backup.py v3开发前

做三件事：
1. 检查工作区是否都已提交（有未提交的改动就停下，避免备份不完整）。
2. 源码：用 git bundle 把整个仓库连同全部历史打包到项目外的
   D:\\claude code\\待办APP-备份\\源码\\<日期>_<时机>.bundle，并校验 bundle 完整。
   恢复：git clone <bundle 文件> 待办APP
3. 数据：检查 data/backups/<日期>_<时机>/ 是否已由 Claude 用 ArtifactData 导出了
   events/、todos/，统计条数，写入 清单.json（含 git 提交号、bundle 路径）。
   数据要先导出、再运行本脚本；没导出时脚本会提示并以退出码 1 结束。
"""
import datetime
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKUP_ROOT = ROOT.parent / "待办APP-备份" / "源码"
ARTIFACT_URL = "https://claude.ai/artifact/MVXvnr3rFUxgFKZesXWGVT"
COLLECTIONS = ("events", "todos")


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")


def fail(msg):
    print("备份失败：" + msg)
    sys.exit(1)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        fail("请写明备份时机，例如：python build/backup.py v3开发前")
    when = sys.argv[1]
    today = datetime.date.today().isoformat()
    tag = f"{today}_{when}"

    # 1. 工作区必须干净
    dirty = git("status", "--porcelain").stdout.strip()
    if dirty:
        fail("还有未提交的改动，先提交再备份：\n" + dirty)
    commit = git("rev-parse", "HEAD").stdout.strip()
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()

    # 2. 源码 bundle
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    bundle = BACKUP_ROOT / f"{tag}.bundle"
    r = git("bundle", "create", str(bundle), "--all")
    if r.returncode != 0:
        fail("git bundle 出错：" + r.stderr)
    v = git("bundle", "verify", str(bundle))
    if v.returncode != 0:
        fail("bundle 校验没通过：" + v.stderr)
    print(f"源码已备份：{bundle}（{bundle.stat().st_size} 字节，提交 {commit[:7]}，分支 {branch}）")

    # 3. 数据
    data_dir = ROOT / "data" / "backups" / tag
    if not data_dir.is_dir():
        fail(f"没找到数据备份文件夹 {data_dir.relative_to(ROOT)}。"
             "请先让 Claude 用 ArtifactData 把 events、todos 导出到这里，再运行本脚本。")
    counts = {}
    for c in COLLECTIONS:
        d = data_dir / c
        counts[c] = len(list(d.glob("*.json"))) if d.is_dir() else 0
    manifest = {
        "备份时机": when,
        "时间": datetime.datetime.now().isoformat(timespec="seconds"),
        "线上地址": ARTIFACT_URL,
        "条数": counts,
        "git 提交": commit,
        "git 分支": branch,
        "源码 bundle": str(bundle),
        "说明": "条数为 0 表示导出时该集合为空。恢复方法见 data/backups/README.md。",
    }
    (data_dir / "清单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"数据已备份：{data_dir.relative_to(ROOT)}  日程 {counts['events']} 条、待办 {counts['todos']} 条")
    print("完成。请在 docs/08-发布/发布记录.md 的“备份记录”里记一笔。")


if __name__ == "__main__":
    main()
