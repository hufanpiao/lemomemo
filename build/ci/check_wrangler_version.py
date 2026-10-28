"""wrangler 两处版本必须一致（架构 0.31 第 26 条）。

- 根目录 package.json 的 devDependencies.wrangler：E2E 的 `wrangler pages dev` 用；
- tools/deploy/package.json 的 dependencies.wrangler：deploy-preview 和 publish.ps1 部署用。
两处写的版本、两份 package-lock.json 里实际锁的版本和 integrity 必须完全一样，否则失败。
升级时两处一起改（各自 `npm install wrangler@<版本> --save-exact --package-lock-only --ignore-scripts`），
版本按“发布满两周”挑（dependabot 的 cooldown 也是 14 天）。

用法（仓库根目录）：python -I build/ci/check_wrangler_version.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXACT = re.compile(r"^\d+\.\d+\.\d+$")


def load(rel: str) -> dict:
    path = ROOT / rel
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SystemExit(f"读不了 {rel}：{e}") from e


def main() -> int:
    problems: list[str] = []

    declared = {
        "package.json（devDependencies）": load("package.json").get("devDependencies", {}).get("wrangler"),
        "tools/deploy/package.json（dependencies）": load("tools/deploy/package.json").get("dependencies", {}).get("wrangler"),
    }
    for where, v in declared.items():
        if not isinstance(v, str) or not EXACT.match(v):
            problems.append(f"{where} 的 wrangler 写的是 {v!r}，必须是精确版本 X.Y.Z")

    locked = {}
    for rel in ("package-lock.json", "tools/deploy/package-lock.json"):
        entry = load(rel).get("packages", {}).get("node_modules/wrangler")
        if not isinstance(entry, dict):
            problems.append(f"{rel} 里没有 node_modules/wrangler：重新生成锁文件")
            continue
        locked[rel] = (entry.get("version"), entry.get("integrity"))

    versions = {v for v in declared.values()} | {v for v, _ in locked.values()}
    integrities = {i for _, i in locked.values()}
    if len(versions) != 1:
        detail = "；".join([f"{k} 写 {v}" for k, v in declared.items()] + [f"{k} 锁 {v}" for k, (v, _) in locked.items()])
        problems.append(f"wrangler 版本不一致：{detail}。两处一起升到同一版")
    elif len(integrities) != 1 or None in integrities:
        problems.append("两份 package-lock.json 里 wrangler 的 integrity 不一样（或缺失）：删掉 node_modules/wrangler 一项后重新生成锁文件")

    if problems:
        for p in problems:
            print(f"::error::{p}")
        return 1
    print(f"wrangler 两处一致：{versions.pop()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
