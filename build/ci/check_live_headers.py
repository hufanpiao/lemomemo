"""部署后核对线上 sw.js 的缓存头（接手清单 SW-update ①，明早清单第 19 条）。

src/_headers 给 /app/sw.js 写的是 `Cache-Control: no-cache`，但 Cloudflare 的“浏览器缓存 TTL”
不是“遵循现有标头”时会改写成 `max-age=14400`，iOS 主屏幕版就会拿着旧 SW 撑几个小时。
本脚本只读：对每个站点发一次 HEAD，Cache-Control 里必须有 no-cache 且不能有大于 0 的 max-age。

用法（仓库根目录）：python -I build/ci/check_live_headers.py [站点 …]
不写站点默认查 https://preview.lemomemo.com。全部通过退出码 0，否则 1。
"""

from __future__ import annotations

import re
import sys
import urllib.error
import urllib.request

DEFAULT_SITES = ["https://preview.lemomemo.com"]
PATH = "/app/sw.js"
MAX_AGE = re.compile(r"(?:^|,)\s*max-age\s*=\s*(\d+)", re.I)


def check(site: str) -> str | None:
    url = site.rstrip("/") + PATH
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "lemo-header-check"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            cc = resp.headers.get("Cache-Control", "")
    except (urllib.error.URLError, OSError) as e:
        return f"{url}：请求失败（{e}）"
    ages = [int(m) for m in MAX_AGE.findall(cc)]
    if "no-cache" not in cc.lower() or any(a > 0 for a in ages):
        return f"{url}：Cache-Control 是 “{cc or '（没有）'}”，应为 no-cache（Cloudflare 浏览器缓存 TTL 要选“遵循现有标头”）"
    print(f"通过  {url}：{cc}")
    return None


def main(argv: list[str]) -> int:
    errors = [e for e in (check(s) for s in (argv or DEFAULT_SITES)) if e]
    for e in errors:
        print(f"失败  {e}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
