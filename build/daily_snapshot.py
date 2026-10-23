"""每日数据快照的收尾：写清单、清理 30 天前的每日快照（ADR-009 补充）。

用法：python build/daily_snapshot.py [日期]      日期默认是今天，格式 YYYY-MM-DD

前提：定时任务已经用 ArtifactData 把 events、todos、logs 导出到
      data/backups/<日期>_每日/events/ 和 .../todos/。
做的事：
1. 统计条数，写 data/backups/<日期>_每日/清单.json；
2. 删除 30 天前的“*_每日”文件夹。只删每日快照，“v3开发前”“发布前”这类版本备份永远不删。
不碰 git，也不备份源码（源码只在版本前和发布前由 build/backup.py 备份）。
"""
import datetime
import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKUPS = ROOT / "data" / "backups"
KEEP_DAYS = 30
SUFFIX = "_每日"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    day = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().isoformat()
    folder = BACKUPS / f"{day}{SUFFIX}"
    for c in ("events", "todos", "logs"):
        (folder / c).mkdir(parents=True, exist_ok=True)
    counts = {c: len(list((folder / c).glob("*.json"))) for c in ("events", "todos", "logs")}
    (folder / "清单.json").write_text(json.dumps({
        "备份时机": "每日自动",
        "时间": datetime.datetime.now().isoformat(timespec="seconds"),
        "条数": counts,
        "说明": "云端 → 本机的单向快照。只保留最近 30 天的每日快照；版本前的备份不会被清理。",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"每日快照：{folder.relative_to(ROOT)}  日程 {counts['events']} 条、待办 {counts['todos']} 条、日志 {counts['logs']} 份")

    cutoff = datetime.date.fromisoformat(day) - datetime.timedelta(days=KEEP_DAYS)
    removed = []
    for d in BACKUPS.glob(f"*{SUFFIX}"):
        try:
            d_day = datetime.date.fromisoformat(d.name[:10])
        except ValueError:
            continue
        if d.is_dir() and d_day < cutoff:
            shutil.rmtree(d)
            removed.append(d.name)
    print("清理旧快照：" + ("、".join(removed) if removed else "无"))


if __name__ == "__main__":
    main()
