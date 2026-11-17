# 改动热点：改过 2 次以上先想新办法，不许一直叠补丁（R-462；负责人 2026-11-17：“改过2次以上的就要想有没有新的更好的办法来做，不是一直叠补丁”“规则也会忘掉”）
# 三种用法：
#   python -I build/check_rewrite.py --commit-msg <提交说明文件>   本机 commit-msg 钩子（.githooks/commit-msg）调
#   python -I build/check_rewrite.py --range <起>..<止>            CI（unit.yml）查推上来、PR 里的每个提交
#   python -I build/check_rewrite.py --hot [天数]                   列最近 N 天（默认 7）改得最多的 10 个源码文件，定时自查用
# 规则：这次提交改到的源码文件，在它之前 30 天里已经被提交过 3 次及以上（= 建好以后又改过 2 次以上），
# 提交说明里必须有一行“重写评估：”加至少 10 个字：这一块前几次修了什么、能不能整块重写、选了哪种做法和理由。
# 只算源码（见 EXTS），测试、文档、生成文件不算（见 SKIP、GENERATED）；合并提交不查、也不计数。
# START 之前的提交不查（规则从这一刻起生效，旧提交补不了说明）。
import os, re, subprocess, sys

EXTS = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.py', '.sql', '.rs')
SKIP = ('__tests__/', 'tests/', 'e2e/', '.test.', '.spec.', 'node_modules/', 'docs/', '/i18n/')
GENERATED = {'src/motion/tokens.ts', 'src/styles/tokens.css'}
LIMIT = 3
DAYS = 30
START = '2026-11-17T16:30:00+08:00'
MARK = re.compile(r'重写评估[:：]\s*(\S.{9,})')


def git(*args):
    r = subprocess.run(['git', *args], capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f'check_rewrite：git {" ".join(args[:2])} 失败：{r.stderr.decode("utf-8", "replace").strip()}')
    return r.stdout.decode('utf-8', 'replace')


def is_src(p):
    return p.endswith(EXTS) and not any(s in p for s in SKIP) and p not in GENERATED


def prior(path, until):
    """until（提交号，或 HEAD）这一刻往前 30 天里，path 被几个非合并提交改过；列表是 [短号 日期 说明]"""
    out = git('log', '--no-merges', f'--since={DAYS}.days', '--format=%h %ad %s', '--date=short', until, '--', path)
    return [l for l in out.splitlines() if l.strip()]


def hot_of(files, until):
    return [(f, logs) for f in files if is_src(f) for logs in [prior(f, until)] if len(logs) >= LIMIT]


def explain(hot):
    lines = []
    for f, logs in hot:
        lines.append(f'  {f}（30 天内已提交 {len(logs)} 次）')
        lines += [f'      {l[:100]}' for l in logs[:4]]
    return '\n'.join(lines)


NEED = ('提交说明里要加一行“重写评估：……”（至少 10 个字）：这一块前几次各修了什么、是不是同一类问题、'
        '能不能整块重写删掉前面的补丁、最后选了哪种做法和理由。负责人 11-17：“改过2次以上的就要想有没有新的更好的办法来做，不是一直叠补丁”。')


def commit_msg(msg_file):
    msg = open(msg_file, encoding='utf-8', errors='replace').read()
    if msg.startswith(('Merge ', 'Revert ')):
        return 0
    files = git('diff', '--cached', '--name-only', '--diff-filter=M').splitlines()
    hot = hot_of(files, 'HEAD')
    if not hot or MARK.search(msg):
        return 0
    print(f'commit-msg：这次改到了改动热点文件，提交已取消。\n{explain(hot)}\n{NEED}', file=sys.stderr)
    return 1


def check_range(rng):
    base = rng.split('..')[0]
    if not base or set(base) == {'0'}:
        print('check_rewrite：没有起点（新分支第一次推），跳过')
        return 0
    bad = []
    for line in git('log', '--no-merges', f'--since={START}', '--format=%H', rng).splitlines():
        sha = line.strip()
        files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=M', sha).splitlines()
        hot = hot_of(files, f'{sha}~1')
        if hot and not MARK.search(git('log', '-1', '--format=%B', sha)):
            bad.append(f'{sha[:8]} {git("log", "-1", "--format=%s", sha).strip()[:80]}\n{explain(hot)}')
    if bad:
        print('check_rewrite：下面这些提交改了改动热点文件，提交说明里没有“重写评估：”：\n' + '\n'.join(bad) + '\n' + NEED, file=sys.stderr)
        return 1
    print('check_rewrite：改动热点都有重写评估')
    return 0


def hot_list(days):
    out = git('log', '--no-merges', f'--since={days}.days', '--name-only', '--format=')
    count = {}
    for p in out.splitlines():
        if p and is_src(p) and os.path.exists(p):
            count[p] = count.get(p, 0) + 1
    top = sorted(count.items(), key=lambda x: -x[1])[:10]
    print(f'最近 {days} 天改得最多的源码文件（≥{LIMIT} 次的下次提交要写重写评估）：')
    for p, n in top:
        print(f'  {n:>3} 次  {p}')
    return 0


def main(argv):
    for st in (sys.stdout, sys.stderr):
        st.reconfigure(encoding='utf-8')
    if len(argv) >= 2 and argv[0] == '--commit-msg':
        return commit_msg(argv[1])
    if len(argv) >= 2 and argv[0] == '--range':
        return check_range(argv[1])
    if argv and argv[0] == '--hot':
        return hot_list(int(argv[1]) if len(argv) > 1 else 7)
    print(__doc__ or '用法见文件头', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
