# 动效、外观改动要写参考对照（负责人 2026-11-18：“乙2（新）那个动效有暗黄吗？”“你说以后怎么做，全凭你的记忆！压缩对话就没有了”“你怎么保证”“提交时硬拦加上”）
# 起因：11-18 子任务照乙2 做，对照图已看出“乙2 亮黄、app 暗黄”，主持人却按代码注释自己加了“0.72 秒后变回暗黄”，参考里没有、负责人也没说过。
# 两种用法：
#   python -I build/check_reference.py --commit-msg <提交说明文件>   本机 commit-msg 钩子（.githooks/commit-msg）调
#   python -I build/check_reference.py --range <起>..<止>            CI（unit.yml）查推上来、PR 里的每个提交
# 规则：这次提交改到动效、外观文件（见 is_look），提交说明里必须同时有两行：
#   参考对照：<参考和这一版并排的逐帧对照图路径，从按下截到画面停住再多 1 秒>   不是照参考做的写“参考对照：无参考，<理由至少 6 个字>”
#   参考外改动：无 / <负责人同意的原话>                                           参考里没有、负责人原话里也没有的东西不许加；加了就写他同意的原话
# 本机提交时“参考对照：”后面写的是路径就查这个文件在不在（CI 上没有本机资料，只查有这两行）。合并、撤销提交不查。START 之前的提交不查。
import os, re, subprocess, sys

START = '2026-11-18T23:50:00+09:00'
LOOK_EXTS = ('.css',)
LOOK_DIRS = ('src/motion/',)
LOOK_FILES = {'docs/02-设计/皮肤-v4/令牌/tokens.json'}
SKIP = ('__tests__/', '.test.', '.spec.', 'node_modules/')
REF = re.compile(r'^参考对照[:：]\s*(\S.*)$', re.M)
NO_REF = re.compile(r'^无参考[，,、\s]*(\S.{5,})$')
EXTRA = re.compile(r'^参考外改动[:：]\s*(\S.*)$', re.M)
NEED = ('提交说明里要有两行：\n'
        '  参考对照：<参考和这一版并排的逐帧对照图路径，从按下截到画面停住再多 1 秒>（不是照参考做的写“参考对照：无参考，<理由>”）\n'
        '  参考外改动：无（加了参考里没有的东西，写负责人同意的原话）\n'
        '负责人 11-18：“乙2（新）那个动效有暗黄吗？”“你怎么保证”“提交时硬拦加上”。')


def git(*args):
    r = subprocess.run(['git', *args], capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f'check_reference：git {" ".join(args[:2])} 失败：{r.stderr.decode("utf-8", "replace").strip()}')
    return r.stdout.decode('utf-8', 'replace')


def is_look(p):
    if any(s in p for s in SKIP):
        return False
    return (p.startswith('src/') and p.endswith(LOOK_EXTS)) or p.startswith(LOOK_DIRS) or p in LOOK_FILES


def problems(msg, local):
    """提交说明缺什么；local 时“参考对照：”写的路径要真有这个文件"""
    out = []
    ref = REF.search(msg)
    if not ref:
        out.append('缺“参考对照：”')
    else:
        v = ref.group(1).strip()
        if v.startswith('无参考'):
            if not NO_REF.match(v):
                out.append('“参考对照：无参考”后面要写理由（至少 6 个字）')
        elif local and not os.path.exists(v.strip('`"“”')):
            out.append(f'“参考对照：”写的对照图不存在：{v}')
    if not EXTRA.search(msg):
        out.append('缺“参考外改动：”')
    return out


def commit_msg(msg_file):
    msg = open(msg_file, encoding='utf-8', errors='replace').read()
    if msg.startswith(('Merge ', 'Revert ')):
        return 0
    files = [f for f in git('diff', '--cached', '--name-only').splitlines() if is_look(f)]
    if not files:
        return 0
    bad = problems(msg, True)
    if not bad:
        return 0
    print('commit-msg：这次改到了动效、外观文件，提交已取消。\n  ' + '\n  '.join(files[:8]) + '\n' + '；'.join(bad) + '\n' + NEED, file=sys.stderr)
    return 1


def check_range(rng):
    base = rng.split('..')[0]
    if not base or set(base) == {'0'}:
        print('check_reference：没有起点（新分支第一次推），跳过')
        return 0
    bad = []
    for line in git('log', '--no-merges', f'--since={START}', '--format=%H', rng).splitlines():
        sha = line.strip()
        msg = git('log', '-1', '--format=%B', sha)
        if msg.startswith('Revert '):
            continue
        files = [f for f in git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).splitlines() if is_look(f)]
        miss = problems(msg, False) if files else []
        if miss:
            bad.append(f'{sha[:8]} {msg.splitlines()[0][:80]}：{"；".join(miss)}（改到 {", ".join(files[:4])}）')
    if bad:
        print('check_reference：下面这些提交改了动效、外观文件，提交说明不全：\n' + '\n'.join(bad) + '\n' + NEED, file=sys.stderr)
        return 1
    print('check_reference：动效、外观改动都写了参考对照')
    return 0


def main(argv):
    for st in (sys.stdout, sys.stderr):
        st.reconfigure(encoding='utf-8')
    if len(argv) >= 2 and argv[0] == '--commit-msg':
        return commit_msg(argv[1])
    if len(argv) >= 2 and argv[0] == '--range':
        return check_range(argv[1])
    print('用法见文件头', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
