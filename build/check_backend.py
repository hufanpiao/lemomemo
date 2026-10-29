"""后端的静态检查：服务器函数的钥匙范围、迁移的写法（B0 返工：QA D-01，安全审查中 1，代码审查中 1）。

用法：python -I build/check_backend.py [--root 目录] [--json]
      python -I build/check_backend.py --print-preview-funcs   （只打印 PREVIEW_FUNCS，一行一个；deploy-preview.yml、publish.ps1 用，名单只写这一处）
      python -I build/check_backend.py --root 样例 --sample-preview-funcs r2-probe   （只给样例测试用：把这些名字当作名单；不能和上一行一起用）
有错误时退出码 1。--root 给自测用（tests/arch-fixtures/check_backend/ 下的样例目录，tests/build/check-backend.test.ts）。

服务器函数（supabase/functions/<函数名>/，下划线开头的目录是共用模块）：
  F1  任何地方不准出现 SUPABASE_DB_URL（注释不算）。架构 6.2、8.4、TC-B0-35
  F2  引到 _shared/db.ts（直接 import，或经别的 _shared 模块间接 import）的函数必须在 DB_FUNCS 里；
      函数自己的代码用 fn_vault / FN_VAULT_DB_URL 的只能是 VAULT_FUNCS，用 fn_ai / FN_AI_DB_URL 的只能是 AI_FUNCS；
      _shared 里只有 db.ts 能读这两个连接串。架构 6.2 表格、8.4、TC-B0-35
  F3  引到 objstore（_shared/objstore*.ts、_shared/gen/objstore*.ts）或直接 import aws4fetch、读 R2_* 的函数必须在 R2_FUNCS 里；
      服务器函数一律不准读 R2_FILES_* / R2_PULL_*（那是 Pages 和负责人本机的令牌）；_shared 里只有 objstore*.ts 能读 R2_*。
      架构第 6 节开头（0.32）、8.4、TC-B0-35（0.35 起；原 TC-B0-75）、S-B0 ⑦。aws4fetch 不论从哪儿引（npm:、esm.sh、jsdelivr、deno.land/x）都算。
      F2、F3、F6 的 import 都先过 import map：supabase/functions 下任何 deno.json、deno.jsonc、import_map.json，它们 importMap 字段指的文件，
      config.toml 里 [functions.x] import_map 指的文件——imports 和 scopes 的别名一律展开后再判断（所有 map 对所有文件都算，宁严勿漏）；
      supabase/functions 下 package.json 的 npm: 依赖别名（"signer": "npm:aws4fetch@x"）也展开（代码审查有条件通过 6）
      源码扩展名：.ts .tsx .mts .cts .js .jsx .mjs .cjs（含 .d.ts、.d.mts；代码审查有条件通过 4）。
      源码一律由 build/check_backend_ast.mjs 用 TypeScript 编译器 API 解析成 AST（代码审查第三轮必改 1）：注释区间、import 边、F7 都从 AST 来
  F7  越界检查的绕法（B0 安全第二轮新低 1、QA D-15、架构 0.34；代码审查有条件通过 1、2，第三轮必改 1、2）——全在 AST 上判断：
      Deno 只准 Deno.env.get('字面量')、Deno.env.has('字面量')、Deno.serve(…)（_shared/db.ts 另准 Deno.env.get(URL_ENV[role])）；
      process 只准默认导入的那个名字、process.env.名字、process.env['字面量']、process.别的属性；node:process 只准
      import process from 'node:process'；globalThis、self、window 只准跟 .标识符（不准当参数、存进变量、方括号、?.；
      Reflect.get、Object.getOwnPropertyDescriptor 的第一个参数是它们的单独说明；别名白名单只有 _shared/gen/objstore-net.ts 的 G）；
      eval、Function、require、createRequire 一律禁用，node:module 不准引；标识符里的反斜杠 u 转义、值正好是 Deno / process / globalThis
      的字符串报；动态 import( ) 的第一个参数必须是字面量；源码解析不了、import map、package.json 解析不了也报。
      第四轮另加：constructor、__proto__、getPrototypeOf、Worker、SharedWorker 一律禁用（标识符、属性名、值正好是这些名字的字符串都算）；
      方括号里的属性名是拼出来的（'De' + 'no'、带 ${} 的模板）报，方括号里不是字面量又马上调用的（x[k](…)）报；
      import 地址不准是 data: / blob:；supabase/functions 下不准有 .cjs、.cts 文件。
      第五轮另加：不准 import 别的函数目录里的文件（只准 _shared/ 和本函数目录，否则“只准某几个函数读”的名单换个函数借用一下就绕开）；
      不准引 node:vm / node:child_process / node:worker_threads（能在本脚本看不见的地方执行代码、起进程）；
      方括号取值 x[k]、解构的计算键 { [k]: v } 的键类型只准 number 或字面量联合（用 TypeScript 类型检查器把 supabase/functions 建成一个 program 判断），
      类型是 string 或推断不出来的变量当键一律报（第五轮，剩余风险①选项乙；第六轮加严，见下面剩余风险①）。
      这些只是代码层门禁：Supabase 函数的 secret 是整个项目共用的（架构 6.2 A28）
  剩余风险（静态检查堵不干净的，写明在这里）：
    ① F7 的定位（10-29 第七轮主持人定）：拦住常见写法，其余靠代码审查。它是静态检查，不是沙箱，不保证堵住所有动态取属性的办法。
       现在拦的（规则细节见 check_backend_ast.mjs 的 KEY_TYPE_WHITELIST 上方）：
       · 方括号 x[k]、解构计算键、Reflect.get / has / set…、Object.getOwnPropertyDescriptor / defineProperty 的键：string、any、unknown、
         类型参数、枚举一律报；字符串字面量类型要追到字面量常量；number 只放行数字字面量、const 数字常量、for 循环下标、.length 的算术；
         字典查表写成 Object.hasOwn(o, k) ? o[k] : …（或 && o[k]，或改用 Map）放行；
       · 普通函数（function）、对象字面量方法里的 this 报；Object.values / keys / entries / assign / getOwnPropertyNames / fromEntries 的参数、
         对象展开 { ...x } 的类型是 any、unknown、object、{}、EventTarget 这类的报（对象字面量本身放行）；不带对象前缀、或挂在
         globalThis / self / window 上的 addEventListener / dispatchEvent / removeEventListener 禁用（第八轮）；Reflect 只准直接调用，apply / construct 的函数只准静态，Object.getOwnPropertyDescriptors 禁用；
       · 检查器建不起来、取类型出错都报错，不放行。
       白名单 KEY_TYPE_WHITELIST 绑节点（第八轮改稳：取值按“函数链 + 本函数里同样文本的第几处”，顶层声明按名字，参数按“函数链 + 参数名”），
       改前面的代码不误报，复制到别的函数对不上；命中后对象不能是 any / unknown，值不能是 any / unknown / 函数。
       10-29 共 19 条：字面量联合类型的参数键 7 处（协调方定保留），number 键收紧后新增的 12 处（待定）。
       已知堵不住、靠代码审查的：从本表没列出的途径拿到全局对象，且类型写得具体；any 值经函数参数、
       返回值流进类型具体的变量；白名单那几处的调用方传入断言出来的值；以及其他本表没有列出的反射写法。
    ② 远程模块和包一旦被 import，里面的代码照样能读环境变量，本脚本只看得到地址、看不到内容：
       远程 https 模块（esm.sh、jsdelivr、deno.land/x 等）、npm: 包、jsr: 包都一样——例如第五轮 d5 的 npm:std-env，
       import 进来就能读到整份环境变量（Deno.env.toObject() 的效果，F1～F3 管不到）。
       现在的兜底：supabase/functions/deno.lock 锁住每个依赖（远程 URL、npm:、jsr:）的完整性哈希，加上 tests/build/deno-config.test.ts
       核对“源码里的 npm: 依赖都在锁里且和 deno.json 一致、jsr: 和不在出站白名单里的 https: 直接禁、supabase/ 下没有避开锁的配置”；
       新加依赖要走代码审查。
  F1  另：SIGNUP_HASH_SECRET 只准 invite-signup、account-purge 读（K2 安全审查，架构 8.4、0.38 第 24 条），Pages、App、shared 里也不准出现（F4）
  F5 disabled_at 只准出现在 _shared/auth.ts、account、account-purge（生成目录 _shared/gen/ 不算）。架构 0.29 续第 138 条④、TC-B0-97 ④
  F6  预览专用函数（supabase/functions/_preview/<函数名>/，只由 deploy-preview.yml 在产物里生成入口部署，正式发布不带）：
      目录名必须在 PREVIEW_FUNCS 里；不准有同名的顶层函数目录（入口只许 CI 生成）；_preview/ 以外的任何文件（函数、_shared）不准 import _preview/ 里的东西；
      _preview/ 下只放函数目录。预览专用函数照样过 F1～F3、F5（能用 R2 的另见 PREVIEW_R2_FUNCS，能经 db.ts 用 fn_ai 的另见 PREVIEW_AI_FUNCS，
      预览专用函数一律不准用 fn_vault；_preview/<名>/ 和正式函数同名也不沾正式名单）。架构 6.2 末尾“越界检查白名单”预览专用一行（B0 P12）
      另外两处绕法（审查中 2）：supabase/ 下除 functions/_preview/ 本身以外，任何文件（config.toml、*.json、迁移、所有源码，注释也算）
      出现 _preview（按词边界：前面不是字母、数字、下划线，所以 vault_preview 这类表名不算）都报；supabase/ 下任何 .toml 里
      出现 [functions.<预览专用函数名>] 都报（CLI 会部署 config.toml 里声明的函数，入口可以指到任何地方）。
      supabase/config.toml 另用 tomllib 解析（第二轮审查低 3）：functions 表的键里不准有预览专用函数（点号键、内联表、
      转义拼出的键名都算），任何函数的 entrypoint 解析后只能在 supabase/functions/ 里面、不能进 functions/_preview/；解析不了也报
Pages Functions（functions/）和 App、shared：
  F4  functions/ 里只有 /files（functions/files/**、functions/_lib/files-*.ts）能 import shared/objstore*.ts、aws4fetch，读 R2_*；
      functions/、src/、shared/ 一律不准出现 R2_FN_*、R2_PULL_*、SUPABASE_DB_URL、FN_VAULT_DB_URL、FN_AI_DB_URL。架构 0.32 第 4 条、8.4
迁移（supabase/migrations/*.sql）：
  M1  security definer 函数必须写 set search_path = ''（create function 和 alter function 都查，属性写在函数体前后都认）。
      架构 0.29 续第 117 条、TC-B0-92
  M2  0001 第一句是 alter default privileges for role postgres revoke execute on functions from public；
      每个函数的 grant / revoke execute 写在建它的同一个文件里、紧跟建函数的语句（中间不能隔别的语句；不写 grant 不算错，默认权限兜底，TC-B0-73 ④）；
      整段 revoke（on all functions in schema）、alter default privileges … on functions 只准在 0001。架构 0.29 续第 32、39 条、3.3 C（0.33）、TC-B0-73 ①②
  M4  授权汇总和架构 3.3 C 逐行比对（TC-B0-73 ①）：迁移里归 3.3 C 管的每一句（函数默认权限、整段收回 private、private 的 schema usage、
      private 函数的 grant / revoke execute、private 表给客户端和 service_role 的 grant、public 表给 service_role 的 grant）都要在 3.3 C 里、
      写在行尾标的文件；3.3 C 标 0001～0007 的每一行在那个文件里恰好一次；标 B1 等的只准进带时间戳的新迁移；附录 A 末尾的语句行和 3.3 C 一字不差。
      给 fn_vault、fn_ai 的表授权归 D1 和 6.2 比（附录 A 末尾注明），对具体 private 表的 revoke 只收不放，不在汇总里
  M5  0001 的先后：全局默认权限 → table_meta、table_meta_of()、touch() → 各表；9 张同步表建表后的下一句是它的 table_meta 行。TC-B0-73 ③、0.29 续第 39 条
  M6  9 张同步表的 (user_id, synced_at) 索引写在建表的文件里。TC-B0-73 ⑤
  M3  0001～0007 七个建表文件里不准打开功能开关：app_config.features 的列默认值里只有 event、todo 能是 on: true，
      不准 update app_config、不准 insert 时写 features、不准 alter column features set default 打开（只准写 JSON 字面量，QA 第二轮 D-15）；
      打开 note、anniv 用带时间戳的数据迁移。架构 0.29 第 1 条（P-02）、TC-B0-68
白名单在脚本里只写一份，出处见每个常量旁的注释；名单的唯一出处是架构 6.2 末尾“越界检查白名单”，改名单要先改架构。
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import tomllib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from check_arch import strip_comments  # noqa: E402  去掉 // 和 /* */，行号不变；只给 import map 的 JSON 用，源码一律走 check_backend_ast.mjs（AST）

# 架构 6.2 末尾越界检查白名单（唯一出处）；6.2 表格、8.4 FN_VAULT_DB_URL 一行：fn_vault 的连接串只给这三个函数
VAULT_FUNCS = frozenset({"vault", "vault-file", "account"})
# 架构 6.2 末尾越界检查白名单（唯一出处）；6.2 表格、8.4：fn_ai 的五个函数，加上只为验 pin_epoch 直连的 ai-parse、ai-voice、vault-image（0.23 安全复核 A2）
AI_FUNCS = frozenset({"ai-embed", "ai-media", "note-search", "ai-summarize", "file-check", "ai-parse", "ai-voice", "vault-image"})
# 能 import _shared/db.ts 的 = 两组的并集
DB_FUNCS = VAULT_FUNCS | AI_FUNCS
# 架构 6.2 末尾越界检查白名单（唯一出处）；第 6 节开头（0.32，R-213）、8.4 R2_FN_* 一行：只有这九个函数能 import _shared/objstore.ts 或读 R2_FN_*、R2_ENDPOINT、R2_BUCKET_PREFIX
R2_FUNCS = frozenset({"file-check", "ai-media", "vault", "vault-file", "vault-image", "storage-sweep", "account", "account-purge", "usage-report"})
# 架构 6.2 末尾越界检查白名单“预览专用”一行（唯一出处）：supabase/functions/_preview/<名>/ 下的一次性函数，只在预览部署（F6）
PREVIEW_DIR = "_preview"
# r2-probe（B0 实测清单 P12）10-28 下线、源码已删。名单空了 F6 照样管：_preview/ 下任何目录都报，
# 别处提到 _preview、config.toml 声明或 entrypoint 指进 _preview/ 也都报
# db-probe（B0 实测清单 P6，10-29 后端提出，一次性；说明和下线步骤见 docs/09-路线图/B0-P6数据库探测函数.md）：测完删，删时把它从这里和下面 PREVIEW_AI_FUNCS 里去掉
PREVIEW_FUNCS = frozenset({"db-probe"})
# 同上：预览专用函数里能用 objstore、读 R2_* 的（现在没有）
PREVIEW_R2_FUNCS = frozenset()
# 同上：预览专用函数里能经 _shared/db.ts 用 fn_ai、读 FN_AI_DB_URL 的（F2；只有 fn_ai，预览专用函数一律不准用 fn_vault）
PREVIEW_AI_FUNCS = frozenset({"db-probe"})
# 架构 0.29 续第 138 条④：除这三处以外不准出现 disabled_at（一律经 _shared/auth.ts 的 isUsable / usableUserIds）
DISABLED_AT_OK = ("_shared/auth.ts", "account/", "account-purge/")
# 架构 8.4、0.38 第 24 条（K2 安全审查）：注册哈希的 HMAC 密钥 SIGNUP_HASH_SECRET 只给这两个函数读（是 account-purge，不是 account）。
#   架构 6.2 末尾白名单的这一行由架构师补
SIGNUP_SECRET_FUNCS = frozenset({"invite-signup", "account-purge"})
SIGNUP_SECRET = re.compile(r"\bSIGNUP_HASH_SECRET\b")

# Deno 和打包器认的源码扩展名都算（代码审查有条件通过 4：原先漏了 .jsx、.cjs、.cts，import 进来的这类文件整个不查）
SOURCE_EXT = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
FN_ROOT = "supabase/functions"

# ---------------- 源码解析（代码审查第三轮必改 1：手写词法器两次被绕过，改用 TypeScript 编译器 API） ----------------
# build/check_backend_ast.mjs 用仓库 node_modules 里的 typescript 把每个源码文件解析成 AST，返回：去掉注释的源码（注释区间由解析器给出）、
# import 边、F7 的结论（Deno、process、globalThis、eval / Function / require、\u 转义、动态 import 全在 AST 上判断）、解析错误
AST_SCRIPT = pathlib.Path(__file__).resolve().parent / "check_backend_ast.mjs"


def parse_sources(items):
    """items：[(键, 绝对路径, 查不查 F7, 相对 supabase/functions 的路径或 None)] → {键: {code, imports, findings, parseError}}"""
    if not items:
        return {}
    payload = json.dumps({"files": [{"rel": k, "path": str(p), "f7": f7, "fnRel": fr} for k, p, f7, fr in items]}, ensure_ascii=False)
    r = subprocess.run(["node", str(AST_SCRIPT)], input=payload.encode("utf-8"), capture_output=True, cwd=str(AST_SCRIPT.parent.parent))
    if r.returncode != 0:
        raise SystemExit(f"build/check_backend_ast.mjs 跑不起来（要先 npm ci 装好 typescript）：{r.stderr.decode('utf-8', 'replace')}")
    try:
        res = json.loads(r.stdout.decode("utf-8"))
    except ValueError as e:
        raise SystemExit(f"build/check_backend_ast.mjs 的输出不是 JSON（{e}），检查不了") from e
    # 第四轮低 1：结果要和送进去的文件清单逐个对上（少一个文件就等于那个文件没查）
    want = {k for k, *_ in items}
    if not isinstance(res, dict) or set(res) != want:
        got = set(res) if isinstance(res, dict) else set()
        raise SystemExit(f"build/check_backend_ast.mjs 的结果和文件清单对不上：送进去 {len(want)} 个、回来 {len(got)} 个"
                         f"（少了 {sorted(want - got)[:5]}，多了 {sorted(got - want)[:5]}），检查不了")
    for k, v in res.items():
        if not isinstance(v, dict) or not all(f in v for f in ("code", "imports", "findings", "parseError")):
            raise SystemExit(f"build/check_backend_ast.mjs 给 {k} 的结果缺字段，检查不了")
    return res


OBJSTORE_SPEC = re.compile(r"(^|/)objstore[\w-]*(\.ts)?$")
# aws4fetch 的各种来源（B0 安全第二轮新低 1）：aws4fetch、npm:aws4fetch@x、https://esm.sh/aws4fetch@x、jsdelivr 的 /npm/aws4fetch、
# deno.land/x/aws4fetch、esm.sh 的 ?alias=x:aws4fetch / ?deps=aws4fetch@x —— 只要某一段以 aws4fetch 开头（后面不是字母数字和 -）就算
AWS4FETCH_SPEC = re.compile(r"(^|[/:=,])aws4fetch(?![\w-])", re.IGNORECASE)
R2_NAME = re.compile(r"\bR2_[A-Z0-9_]+")
VAULT_USE = re.compile(r"""\bFN_VAULT_DB_URL\b|['"`]fn_vault['"`]""")
AI_USE = re.compile(r"""\bFN_AI_DB_URL\b|['"`]fn_ai['"`]""")
# SIGNUP_HASH_SECRET（K2）也只给服务器函数，Pages、App、shared 里不准出现
PAGES_FORBIDDEN = re.compile(r"\b(R2_FN_[A-Z0-9_]*|R2_PULL_[A-Z0-9_]*|SUPABASE_DB_URL|FN_VAULT_DB_URL|FN_AI_DB_URL|SIGNUP_HASH_SECRET)\b")


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def imports(ast):
    """AST 给出的 import：[(行号, spec, 只是类型)]（import、export … from、import x = require、字面量的动态 import）"""
    return [(i["line"], i["spec"], bool(i["typeOnly"])) for i in ast["imports"]]


IMPORT_MAP_NAMES = ("deno.json", "deno.jsonc", "import_map.json")


def load_import_maps(root, errors):
    """F2、F3、F6 用（S3 import map 别名）：[(键, 目标, map 所在目录)]。来源：supabase/functions 下所有 deno.json、deno.jsonc、
    import_map.json，这些文件 importMap 字段指的文件，config.toml 里 [functions.x] import_map 指的文件。imports 和 scopes 都收；
    解析不了的报 F7（没法确认别名指到哪儿）"""
    base = root / FN_ROOT
    todo = []
    if base.exists():
        todo += [p for p in sorted(base.rglob("*")) if p.is_file() and p.name in IMPORT_MAP_NAMES and "node_modules" not in p.parts]
    cfg = root / CONFIG_TOML
    if cfg.exists():
        try:
            fns = tomllib.loads(cfg.read_text(encoding="utf-8")).get("functions", {})
        except tomllib.TOMLDecodeError:
            fns = {}   # F6 另报解析不了
        for conf in (fns.values() if isinstance(fns, dict) else []):
            if isinstance(conf, dict) and isinstance(conf.get("import_map"), str):
                todo.append(root / "supabase" / conf["import_map"])
    entries, seen = [], set()
    while todo:
        p = todo.pop(0)
        rp = p.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        try:
            rel = rp.relative_to(root.resolve()).as_posix()
        except ValueError:
            rel = str(p)
        if not p.is_file():
            errors.append(("F7", rel, 1, "import map 文件不存在（config.toml 或 deno.json 指过去的），没法确认别名指到哪儿"))
            continue
        try:
            data = json.loads(strip_comments(p.read_text(encoding="utf-8")))
            if not isinstance(data, dict):
                raise ValueError("顶层不是对象")
        except ValueError as e:
            errors.append(("F7", rel, 1, f"import map 解析不了（{e}），没法确认别名指到哪儿"))
            continue
        if isinstance(data.get("importMap"), str):
            todo.append(p.parent / data["importMap"])
        groups = [data.get("imports")] + list((data.get("scopes") or {}).values() if isinstance(data.get("scopes"), dict) else [])
        for g in groups:
            if g is None:
                continue
            if not isinstance(g, dict):
                errors.append(("F7", rel, 1, "import map 的 imports / scopes 必须是对象"))
                continue
            for k, v in g.items():
                if isinstance(v, str):
                    entries.append((k, v, p.parent))
    entries += load_package_aliases(root, errors)
    return entries


PKG_DEP_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
# 版本号写法（^1.2.3、~1、>=1 <2、1.x、*、latest 这类 dist-tag）：包名就是键名本身，import 的 spec 已经能看出是什么包
PKG_SEMVER = re.compile(r"^[\s\d.xX*^~<>=|v-]*$|^[A-Za-z][\w.-]*$")


def load_package_aliases(root, errors):
    """F3（代码审查有条件通过 6）：supabase/functions 下（不含 node_modules）每个 package.json 的依赖别名，
    "signer": "npm:aws4fetch@1.0.20" 这种——import 'signer' 实际引的是 aws4fetch，展开后再判断（"signer/x" 也展开）。
    版本号写法的依赖不用展开；file:、git、http、link:、workspace: 这类看不出指到哪儿，报 F7；解析不了也报 F7"""
    base = root / FN_ROOT
    out = []
    if not base.exists():
        return out
    for p in sorted(base.rglob("package.json")):
        if not p.is_file() or "node_modules" in p.parts:
            continue
        rel = p.relative_to(root).as_posix()
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("顶层不是对象")
        except ValueError as e:
            errors.append(("F7", rel, 1, f"package.json 解析不了（{e}），没法确认依赖别名指到哪儿"))
            continue
        for field in PKG_DEP_FIELDS:
            deps = data.get(field)
            if deps is None:
                continue
            if not isinstance(deps, dict):
                errors.append(("F7", rel, 1, f"package.json 的 {field} 必须是对象"))
                continue
            for k, v in deps.items():
                if not isinstance(v, str):
                    errors.append(("F7", rel, 1, f"package.json 的 {field}.{k} 不是字符串，没法确认指到哪儿"))
                elif v.startswith("npm:"):
                    out.append((k, v, p.parent))
                    out.append((k + "/", v + "/", p.parent))
                elif not PKG_SEMVER.match(v):
                    errors.append(("F7", rel, 1, f"package.json 的 {field}.{k} 是 “{v}”（不是版本号也不是 npm: 别名），没法确认指到哪儿"))
    return out


class Fns:
    """supabase/functions 下的源码：去掉注释的代码、相对 import 的边（先按 import map 展开别名）"""

    def __init__(self, root, errors=None):
        self.root = root
        self.base = root / FN_ROOT
        self.code = {}
        self.ast = {}   # check_backend_ast.mjs 的结果：imports、findings（F7）、parseError
        items = []
        if self.base.exists():
            for p in sorted(self.base.rglob("*")):
                if p.is_file() and p.suffix in SOURCE_EXT and "node_modules" not in p.parts:
                    rel = p.relative_to(self.base).as_posix()
                    items.append((rel, p, True, rel))
        for rel, res in parse_sources(items).items():
            self.ast[rel] = res
            self.code[rel] = res["code"]
        self.maps = load_import_maps(root, errors if errors is not None else [])
        self._closure = {}

    def _target(self, path):
        try:
            t = path.resolve().relative_to(self.base.resolve()).as_posix()
            return t if t in self.code else None
        except ValueError:
            return None   # 指到 supabase/functions 外面（部署时不存在），按 spec 判断

    def edges(self, rel):
        """rel 的 import：[(行号, 目标 rel 或 None, spec)]；类型 import 跳过（编译后不存在）。
        spec 命中 import map 的键（整个相等，或键以 / 结尾、spec 以它开头）时，展开后的每个结果各算一条边（原 spec 也留一条）"""
        out = []
        for line, spec, type_only in imports(self.ast[rel]):
            if type_only:
                continue
            target = self._target((self.base / rel).parent / spec) if spec.startswith(".") else None
            out.append((line, target, spec))
            for mapped, d in self.expand(spec):
                t = self._target(d / mapped) if mapped.startswith(".") else None
                out.append((line, t, mapped))
        return out

    def expand(self, spec):
        """spec 经 import map、package.json 别名展开后的结果：[(展开后的 spec, map 所在目录)]（不含原 spec；相对路径不展开）"""
        if spec.startswith("."):
            return []
        out = []
        for k, v, d in self.maps:
            if spec == k or (k.endswith("/") and spec.startswith(k)):
                out.append((v + spec[len(k):] if k.endswith("/") else v, d))
        return out

    def closure(self, rel):
        """从 rel 出发能引到的文件和外部 spec（含自己）"""
        if rel in self._closure:
            return self._closure[rel]
        files, specs, todo = {rel}, set(), [rel]
        while todo:
            cur = todo.pop()
            for _, target, spec in self.edges(cur):
                specs.add(spec)
                if target and target not in files:
                    files.add(target)
                    todo.append(target)
        self._closure[rel] = (files, specs)
        return files, specs


def is_preview(rel):
    return rel.startswith(PREVIEW_DIR + "/")


def owner(rel):
    """函数名；预览专用函数（_preview/<名>/…）返回 <名>；共用模块（_shared 等下划线开头的目录、根目录的文件）返回 None"""
    parts = rel.split("/")
    if parts[0] == PREVIEW_DIR:
        return parts[1] if len(parts) >= 3 else None
    return None if len(parts) == 1 or parts[0].startswith("_") else parts[0]


def same_fn(a, b):
    """两个文件属于同一个函数目录（顶层的 x/ 和 _preview/x/ 不算同一个）"""
    return owner(a) is not None and owner(a) == owner(b) and is_preview(a) == is_preview(b)


def check_preview(fns, errors):
    """F6：预览专用函数只在 _preview/ 里、只在名单里，正式会部署的代码引不到它"""
    reported = set()
    for rel in fns.code:
        path = f"{FN_ROOT}/{rel}"
        fn = owner(rel)
        if is_preview(rel):
            if fn is None:
                errors.append(("F6", path, 1, f"{PREVIEW_DIR}/ 下只放预览专用函数的目录（{PREVIEW_DIR}/<函数名>/），不放共用文件"))
            elif fn not in PREVIEW_FUNCS and fn not in reported:
                reported.add(fn)
                errors.append(("F6", path, 1, f"{PREVIEW_DIR}/{fn}/ 不在预览专用函数的名单里（PREVIEW_FUNCS，出处架构 6.2 末尾）"))
            continue
        if fn in PREVIEW_FUNCS:
            errors.append(("F6", path, 1, f"{fn} 是预览专用函数，源码只放 {PREVIEW_DIR}/{fn}/；顶层入口只由 deploy-preview.yml 在产物里生成，不进仓库（否则正式发布会把它带上去）"))
        for line, target, spec in fns.edges(rel):
            if (target and is_preview(target)) or re.search(r"(^|/)" + PREVIEW_DIR + r"/", spec):
                errors.append(("F6", path, line, f"正式会部署的代码不准 import {PREVIEW_DIR}/ 里的东西（{spec}）：预览专用函数只在预览部署"))


def is_db(rel):
    return rel == "_shared/db.ts"


def is_objstore_file(rel):
    return re.match(r"^_shared/(gen/)?objstore[\w-]*\.ts$", rel) is not None


def touches_objstore(files, specs):
    return any(is_objstore_file(f) for f in files) or any(OBJSTORE_SPEC.search(s) or AWS4FETCH_SPEC.search(s) for s in specs)


# 词边界的 _preview：前面不是字母、数字、下划线（vault_preview 不算）
PREVIEW_WORD = re.compile(r"(?<![A-Za-z0-9_])" + PREVIEW_DIR + r"(?![A-Za-z0-9_])")
SUPABASE_SKIP = (".temp", ".branches")


def check_preview_mentions(root, errors):
    """F6：supabase/ 下 _preview/ 以外的文件不准提到 _preview；.toml 里不准声明预览专用函数"""
    base = root / "supabase"
    if not base.exists():
        return
    own = (base / "functions" / PREVIEW_DIR).resolve()
    decl = re.compile(r"""^\s*\[\s*functions\s*\.\s*["']?(""" + "|".join(re.escape(n) for n in sorted(PREVIEW_FUNCS)) + r""")["']?\s*[\].]""", re.MULTILINE) if PREVIEW_FUNCS else None
    for p in sorted(base.rglob("*")):
        if not p.is_file() or "node_modules" in p.parts or any(part in SUPABASE_SKIP for part in p.relative_to(base).parts):
            continue
        rp = p.resolve()
        if rp == own or own in rp.parents:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue   # 二进制文件
        rel = p.relative_to(root).as_posix()
        for m in PREVIEW_WORD.finditer(text):
            errors.append(("F6", rel, line_of(text, m.start()), f"supabase/ 下只有 functions/{PREVIEW_DIR}/ 自己能提到 {PREVIEW_DIR}（配置、声明、源码、注释都不行）：预览专用函数的入口和配置只由 deploy-preview.yml 在产物里生成"))
        if decl and p.suffix == ".toml" and rel != CONFIG_TOML:   # config.toml 另用 tomllib 解析（check_config_toml）
            for m in decl.finditer(text):
                errors.append(("F6", rel, line_of(text, m.start()), f"不准在配置里声明预览专用函数 [functions.{m.group(1)}]：CLI 会按声明部署它（正式发布也会），预览的设置只由 deploy-preview.yml 写进产物"))


CONFIG_TOML = "supabase/config.toml"


def _toml_line(lines, *needles):
    """找第一行（跳过注释行）同时含所有 needles 的行号（1 起）；找不到退一步只找第一个，再找不到报 1"""
    for group in (needles, needles[:1]):
        for i, line in enumerate(lines, 1):
            if not line.lstrip().startswith("#") and all(n in line for n in group):
                return i
    return 1


def check_config_toml(root, errors):
    """F6（第二轮审查低 3）：用 tomllib 解析 supabase/config.toml，按解析结果查 functions 表：
    ① 键里不能有预览专用函数（[functions.x]、点号键、内联表、带 \\u 转义的引号键都算）；
    ② 任何函数的 entrypoint 都只能指到 supabase/functions/ 里面，而且不能指进 functions/_preview/。"""
    cfg = root / CONFIG_TOML
    if not cfg.exists():
        return
    text = cfg.read_text(encoding="utf-8")
    lines = text.splitlines()
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        errors.append(("F6", CONFIG_TOML, getattr(e, "lineno", 1) or 1, f"config.toml 解析不了（{e}），没法确认里面没有声明预览专用函数"))
        return
    fns = data.get("functions", {})
    if not isinstance(fns, dict):
        errors.append(("F6", CONFIG_TOML, _toml_line(lines, "functions"), "config.toml 的 functions 必须是表"))
        return
    base = (root / "supabase").resolve()
    fn_root = (base / "functions").resolve()
    preview = (fn_root / PREVIEW_DIR).resolve()
    for name, conf in fns.items():
        if name in PREVIEW_FUNCS:
            errors.append(("F6", CONFIG_TOML, _toml_line(lines, name) if name in text else _toml_line(lines, "functions"),
                           f"不准在配置里声明预览专用函数 [functions.{name}]（tomllib 解析出来的键）：CLI 会按声明部署它（正式发布也会），预览的设置只由 deploy-preview.yml 写进产物"))
        if not isinstance(conf, dict) or "entrypoint" not in conf:
            continue
        ep = conf["entrypoint"]
        target = (base / str(ep)).resolve() if isinstance(ep, str) else None
        if target is None or not (fn_root in target.parents) or target == preview or preview in target.parents:
            errors.append(("F6", CONFIG_TOML, _toml_line(lines, "entrypoint", name) if name in text else _toml_line(lines, "entrypoint"),
                           f"[functions.{name}] 的 entrypoint 只能指到 supabase/functions/ 里面、而且不能指进 functions/{PREVIEW_DIR}/（按解析后的路径判断）"))


# F7（代码审查第三轮）：Deno、process、globalThis、eval / Function / require / createRequire、标识符转义、动态 import 的判断
#   全在 AST 上做（build/check_backend_ast.mjs 文件头写了每一条），这里只收结论，另按 import 查 node:process 和 node:module
PROCESS_SPECS = ("node:process", "process", "npm:process")
# node:module 的 createRequire 能不写字面量就 require 任意模块（第三轮 b9）
MODULE_SPECS = ("node:module", "module", "npm:module")
# 第五轮必改 2、3：能执行代码或起进程的内置模块（经 import map、package.json 别名展开后也查）
RUNTIME_SPECS = tuple(f"{pre}{name}" for name in ("vm", "child_process", "worker_threads") for pre in ("node:", "", "npm:"))
# 第四轮必改 4：CommonJS 在非严格模式下能用 this 拿到 globalThis，supabase/functions 下整个不准有
CJS_EXT = (".cjs", ".cts")


def import_findings(fns, rel):
    """node:process 只准 import process from 'node:process'（具名、命名空间、和别的绑定混写、export … from、动态 import、require 都报）；
    node:module 一律不准引。spec 先经 import map、package.json 别名展开"""
    def hits(spec, names):
        return spec in names or any(s in names for s, _ in fns.expand(spec))
    out = []
    for i in fns.ast[rel]["imports"]:
        if i["typeOnly"]:
            continue
        spec = i["spec"]
        if any(re.match(r"\s*(data|blob):", x, re.IGNORECASE) for x in [spec] + [m for m, _ in fns.expand(spec)]):
            out.append((i["line"], f"import 地址不准用 data: / blob:（{spec[:40]}…）：模块内容就写在地址里，F1～F7 都查不了（第四轮必改 2）"))
        elif hits(spec, MODULE_SPECS):
            out.append((i["line"], f"不准引 {spec}（createRequire 能不写字面量就拿到任意模块，F2、F3、F7 都查不了）"))
        elif hits(spec, RUNTIME_SPECS):
            out.append((i["line"], f"不准引 {spec}（vm、child_process、worker_threads 能在本脚本看不见的地方执行代码或起进程，第五轮必改 2、3）"))
        elif hits(spec, PROCESS_SPECS):
            ok = i["kind"] == "import" and (i.get("bare") or (i.get("defaultName") == "process" and not i.get("named") and not i.get("namespace")))
            if not ok:
                out.append((i["line"], f"{spec} 只准默认导入（import process from 'node:process'，再按 process.env.名字 读）：具名导入 env、"
                                       "命名空间导入、export … from、动态 import 都绕得过 process 的检查"))
    return out


def check_bypass(fns, errors):
    """F7（S3）：拼接环境变量名、Deno.env.toObject()、非字面量动态 import —— 这些写法让 F1～F3 的名字匹配看不见读的是什么"""
    for rel, res in fns.ast.items():
        path = f"{FN_ROOT}/{rel}"
        if rel.endswith(CJS_EXT):
            errors.append(("F7", path, 1, "supabase/functions 下不准有 .cjs、.cts 文件（Deno 2 会执行从 ESM 引进来的 CommonJS，"
                                          "里面 (function () { return this })() 就能拿到 globalThis，第四轮必改 4）"))
        if res.get("parseError"):
            errors.append(("F7", path, 1, f"解析不了（{res['parseError']}），没法确认里面读了什么、引了什么"))
        for f in res["findings"]:
            errors.append(("F7", path, f["line"], f["message"]))
        for line, msg in import_findings(fns, rel):
            errors.append(("F7", path, line, msg))
        # 第五轮必改 1：不准 import 别的函数目录里的文件（只准 _shared/ 和本函数目录）。
        #   否则 SIGNUP_HASH_SECRET、fn_vault 这类“只准某几个函数读”的规则，换个函数 import 一下就绕开了
        for line, target, spec in fns.edges(rel):
            # 引 _preview/ 里的东西由 F6 管（这里跳过，不重复报）；只拦正式函数之间互相借用
            if target is not None and owner(target) is not None and not same_fn(target, rel) and not is_preview(target) and not is_preview(rel):
                errors.append(("F7", path, line, f"不准 import 别的函数目录里的文件（{spec}）：只准引 _shared/ 和本函数目录，"
                                                 "否则“只准某几个函数读”的名单换个函数 import 一下就绕开了"))


def check_functions(root, errors):
    check_preview_mentions(root, errors)
    check_config_toml(root, errors)
    fns = Fns(root, errors)
    check_preview(fns, errors)
    check_bypass(fns, errors)
    for rel, code in fns.code.items():
        path = f"{FN_ROOT}/{rel}"
        fn = owner(rel)
        gen = rel.startswith("_shared/gen/")
        # 能用 R2 的：九个函数；预览专用函数另看 PREVIEW_R2_FUNCS（顶层同名目录不算，F6 另报）
        r2_ok = fn in (PREVIEW_R2_FUNCS if is_preview(rel) else R2_FUNCS)
        # 能直连数据库的：DB_FUNCS / VAULT_FUNCS / AI_FUNCS；预览专用函数只看 PREVIEW_AI_FUNCS（只许 fn_ai，不许 fn_vault；
        # 所以 _preview/vault/ 这种和正式函数同名的目录也拿不到正式函数的名额）
        db_ok = fn in (PREVIEW_AI_FUNCS if is_preview(rel) else DB_FUNCS)
        vault_ok = (not is_preview(rel)) and fn in VAULT_FUNCS
        ai_ok = fn in (PREVIEW_AI_FUNCS if is_preview(rel) else AI_FUNCS)

        # F1
        for m in re.finditer(r"\bSUPABASE_DB_URL\b", code):
            errors.append(("F1", path, line_of(code, m.start()), "服务器函数禁止用默认的 SUPABASE_DB_URL（postgres 角色，绕开 RLS），直连一律经 _shared/db.ts 用 fn_vault / fn_ai"))
        # F1（K2 安全审查，架构 8.4、0.38 第 24 条）：SIGNUP_HASH_SECRET 只准 invite-signup、account-purge 自己的文件读；
        #   共用模块、预览专用函数、别的函数一律不准（注释不算）
        if is_preview(rel) or fn not in SIGNUP_SECRET_FUNCS:
            for m in SIGNUP_SECRET.finditer(code):
                errors.append(("F1", path, line_of(code, m.start()), f"SIGNUP_HASH_SECRET 只准 {'、'.join(sorted(SIGNUP_SECRET_FUNCS))} 读（架构 8.4、0.38 第 24 条），{fn or '共用模块'} 不准读"))

        # F5
        if not gen and not rel.startswith(DISABLED_AT_OK):
            for m in re.finditer(r"\bdisabled_at\b", code):
                errors.append(("F5", path, line_of(code, m.start()), "disabled_at 只准出现在 _shared/auth.ts、account、account-purge；判断账号能不能用一律经 _shared/auth.ts 的 isUsable / usableUserIds（private.account_usable）"))

        if gen:
            continue   # 生成目录是 shared/ 的副本，F4 在 shared/ 上查

        if fn is None:
            # 共用模块：连接串只在 db.ts 读；R2_* 只在 objstore*.ts 读，而且不准是 R2_FILES_* / R2_PULL_*
            if not is_db(rel):
                for m in re.finditer(r"\bFN_(VAULT|AI)_DB_URL\b", code):
                    errors.append(("F2", path, line_of(code, m.start()), f"{m.group(0)} 只准在 _shared/db.ts 里读"))
            for m in R2_NAME.finditer(code):
                name = m.group(0)
                if name.startswith(("R2_FILES_", "R2_PULL_")):
                    errors.append(("F3", path, line_of(code, m.start()), f"服务器函数不准读 {name}（Pages / 本机的令牌），用 R2_FN_*"))
                elif not is_objstore_file(rel):
                    errors.append(("F3", path, line_of(code, m.start()), f"{name} 只准在 _shared/objstore.ts 里读"))
            continue

        # 函数自己的文件：经 import 引到的东西（同一个函数目录里的文件各自检查，这里只看引到目录外的）
        for line, target, spec in fns.edges(rel):
            if target is not None and same_fn(target, rel):
                continue
            files, specs = fns.closure(target) if target else (set(), set())
            specs = specs | {spec}
            via = f"（经 {target}）" if target and not is_db(target) and not is_objstore_file(target) else ""
            if not db_ok and (any(is_db(f) for f in files)):
                errors.append(("F2", path, line, f"{fn} 不在能直连数据库的名单里，却引到 _shared/db.ts{via}（名单见架构 6.2）"))
            if not r2_ok and touches_objstore(files, specs):
                errors.append(("F3", path, line, f"{fn} 不在能用 R2 的九个函数里，却引到对象存储（objstore / aws4fetch）{via}（名单见架构第 6 节开头）"))

        # 函数自己的代码：角色和变量
        for m in VAULT_USE.finditer(code):
            if not vault_ok:
                errors.append(("F2", path, line_of(code, m.start()), f"{fn} 用了 fn_vault（{m.group(0)}），只有 vault、vault-file、account 能用"))
        for m in AI_USE.finditer(code):
            if not ai_ok:
                errors.append(("F2", path, line_of(code, m.start()), f"{fn} 用了 fn_ai（{m.group(0)}），不在 fn_ai 的名单里"))
        for m in R2_NAME.finditer(code):
            name = m.group(0)
            if name.startswith(("R2_FILES_", "R2_PULL_")):
                errors.append(("F3", path, line_of(code, m.start()), f"服务器函数不准读 {name}（Pages / 本机的令牌），用 R2_FN_*"))
            elif not r2_ok:
                errors.append(("F3", path, line_of(code, m.start()), f"{fn} 不在能用 R2 的九个函数里，却读 {name}"))


def iter_code(root, top):
    """F4：top 下的源码 → [(相对仓库根的路径, AST 结果)]（不查 F7）"""
    base = root / top
    if not base.exists():
        return []
    items = [(p.relative_to(root).as_posix(), p, False, None) for p in sorted(base.rglob("*"))
             if p.is_file() and p.suffix in SOURCE_EXT and "node_modules" not in p.parts]
    return sorted(parse_sources(items).items())


def files_scope(rel):
    return rel.startswith("functions/files/") or re.match(r"^functions/_lib/files-[^/]+$", rel) is not None


def check_pages(root, errors):
    for top in ("functions", "src", "shared"):
        for rel, res in iter_code(root, top):
            code = res["code"]
            if res.get("parseError"):   # 第四轮低 1：解析不了时 code 可能是空串，不能当 0 个问题
                errors.append(("F4", rel, 1, f"解析不了（{res['parseError']}），没法确认里面没有越界的名字和 import"))
            for m in PAGES_FORBIDDEN.finditer(code):
                errors.append(("F4", rel, line_of(code, m.start()), f"{m.group(0)} 只给 Supabase 的服务器函数（或负责人本机）用，Pages、App、shared 里不准出现"))
            if top != "functions" or files_scope(rel):
                continue
            for line, spec, _ in imports(res):
                if OBJSTORE_SPEC.search(spec) or AWS4FETCH_SPEC.search(spec):
                    errors.append(("F4", rel, line, f"Pages Functions 里只有 /files 能用对象存储（{spec}）"))
            for m in R2_NAME.finditer(code):
                if not PAGES_FORBIDDEN.match(m.group(0)):
                    errors.append(("F4", rel, line_of(code, m.start()), f"Pages Functions 里只有 /files 能读 {m.group(0)}"))


# ---------------- 迁移 ----------------

def sql_statements(raw):
    """切成语句：[(起始偏移, 原文, 遮住字符串内容的文本)]。注释换成空格（行号不变）；
    单引号字符串和 $tag$ 字符串的内容换成 x（引号和 tag 留着，'' 仍是 ''），这样属性只会在字符串外面匹配到"""
    masked, i, n = [], 0, len(raw)
    while i < n:
        c = raw[i]
        if raw.startswith("--", i):
            j = raw.find("\n", i)
            j = n if j < 0 else j
            masked.append(" " * (j - i))
            i = j
        elif raw.startswith("/*", i):
            j = raw.find("*/", i + 2)
            j = n if j < 0 else j + 2
            masked.append(re.sub(r"[^\n]", " ", raw[i:j]))
            i = j
        elif c == "'":
            j = i + 1
            while j < n:
                if raw[j] == "'" and raw.startswith("''", j):
                    j += 2
                    continue
                if raw[j] == "'":
                    break
                j += 1
            masked.append("'" + re.sub(r"[^\n]", "x", raw[i + 1:j]) + "'")
            i = j + 1
        elif c == "$" and (m := re.match(r"\$[A-Za-z_]*\$", raw[i:])):
            tag = m.group(0)
            j = raw.find(tag, i + len(tag))
            j = n if j < 0 else j
            masked.append(tag + re.sub(r"[^\n]", "x", raw[i + len(tag):j]) + (tag if j < n else ""))
            i = j + len(tag)
        else:
            masked.append(c)
            i += 1
    text = "".join(masked)[:n]
    out, start = [], 0
    for k, ch in enumerate(text):
        if ch == ";":
            out.append((start, raw[start:k], text[start:k]))
            start = k + 1
    if text[start:].strip():
        out.append((start, raw[start:], text[start:]))
    # 起始偏移挪到第一个非空白字符
    res = []
    for s, r, t in out:
        lead = len(t) - len(t.lstrip())
        if t.strip():
            res.append((s + lead, r[lead:], t[lead:]))
    return res


NAME = r"""((?:"?[A-Za-z_][\w]*"?\.)?"?[A-Za-z_][\w]*"?)"""
CREATE_FN = re.compile(r"^create\s+(?:or\s+replace\s+)?function\s+" + NAME, re.IGNORECASE)
ALTER_FN = re.compile(r"^alter\s+function\s+" + NAME, re.IGNORECASE)
EXEC_PRIV = re.compile(r"^(grant|revoke)\s+(?:grant\s+option\s+for\s+)?(?:execute|all(?:\s+privileges)?)\s+on\s+functions?\s+(.*?)\s+\b(?:to|from)\b", re.IGNORECASE | re.DOTALL)
FIRST_0001 = "alter default privileges for role postgres revoke execute on functions from public"


def fn_key(name):
    name = name.replace('"', "").lower()
    return name if "." in name else f"public.{name}"


def check_migrations(root, errors):
    mig = root / "supabase" / "migrations"
    if not mig.exists():
        return
    parsed = []
    for p in sorted(mig.glob("*.sql")):
        rel = p.relative_to(root).as_posix()
        raw = p.read_text(encoding="utf-8")
        parsed.append((p.name, rel, raw, sql_statements(raw)))

    created = {}   # 函数 → [(文件, 偏移)]
    for name, rel, raw, stmts in parsed:
        for off, _, t in stmts:
            m = CREATE_FN.match(t)
            if m:
                created.setdefault(fn_key(m.group(1)), []).append((rel, off))

    for name, rel, raw, stmts in parsed:
        is_0001 = name.startswith("0001_")
        is_build = re.match(r"^000[1-7]_", name) is not None
        granted = {}   # 函数 → 本文件里 grant / revoke 的偏移
        for off, r, t in stmts:
            line = line_of(raw, off)
            flat = re.sub(r"\s+", " ", t).strip().lower()

            # M1
            m = CREATE_FN.match(t) or ALTER_FN.match(t)
            if m and re.search(r"\bsecurity\s+definer\b", t, re.IGNORECASE) and not re.search(r"\bset\s+search_path\s*(=|to)\s*''", t, re.IGNORECASE):
                errors.append(("M1", rel, line, f"{fn_key(m.group(1))} 是 security definer，没写 set search_path = ''"))

            # M2
            if flat.startswith("revoke") and re.search(r"\bon all functions in schema\b", flat) and not is_0001:
                errors.append(("M2", rel, line, "整段 revoke（on all functions in schema）只准在 0001；别的文件按函数逐个写"))
            if flat.startswith("alter default privileges") and re.search(r"\bon functions\b", flat) and not is_0001:
                errors.append(("M2", rel, line, "函数的默认权限只准在 0001 改"))
            g = EXEC_PRIV.match(t)
            if g and not re.match(r"all\s+functions\s+in\s+schema", g.group(2), re.IGNORECASE):
                for fm in re.finditer(NAME + r"\s*\(", g.group(2)):
                    k = fn_key(fm.group(1))
                    if k not in created:
                        continue   # 不是迁移里建的函数（扩展、auth.* 等），不管
                    if not any(f == rel and o < off for f, o in created[k]):
                        errors.append(("M2", rel, line, f"{k} 的 {g.group(1).lower()} 要写在建它的文件里、紧跟建函数的语句（建在 {created[k][0][0]}）"))
                    granted.setdefault(k, []).append(off)

            # M3
            if is_build:
                if re.match(r"^update\s+(only\s+)?(\"?public\"?\.)?\"?app_config\"?\b", flat):
                    errors.append(("M3", rel, line, "0001～0007 建表文件里不准 update app_config 打开功能开关，用带时间戳的数据迁移"))
                if re.match(r"^insert\s+into\s+(\"?public\"?\.)?\"?app_config\"?\b", flat) and re.search(r"\bfeatures\b", flat):
                    errors.append(("M3", rel, line, "0001～0007 建表文件里插 app_config 不准写 features（用列默认值），开关用带时间戳的数据迁移打开"))
                # 建表时的列默认值；或 alter table app_config … alter column features set default（QA 第二轮 D-15）。
                # 在遮住注释和字符串内容的文本 t 上逐个找（代码第三轮新低 1：原先在原文上只找第一处，注释里写一句或同一句写两个子句就漏了），
                # 字面量的内容按同样的偏移回原文 r 里取（t 和 r 逐字对齐）
                for fpos, lit in features_defaults(t, r, flat):
                    fline = line_of(raw, off + fpos)
                    if lit is None:
                        errors.append(("M3", rel, fline, "0001～0007 建表文件里 app_config.features 的列默认值只准写 JSON 字面量（才查得了开关开没开）"))
                        continue
                    try:
                        feats = json.loads(lit.replace("''", "'"))
                    except ValueError:
                        errors.append(("M3", rel, fline, "app_config.features 的列默认值不是合法的 JSON"))
                        feats = {}
                    for k, v in (feats.items() if isinstance(feats, dict) else []):
                        if k not in ("event", "todo") and isinstance(v, dict) and v.get("on") is not False:
                            errors.append(("M3", rel, fline, f"app_config.features 的列默认值里 {k} 不是 on: false：0001～0007 建表文件不准打开开关，用带时间戳的数据迁移"))

        # M2：0001 第一句；本文件建的每个函数，后面都要有本文件的 grant / revoke
        if is_0001:
            first = stmts[0] if stmts else None
            if not first or re.sub(r"\s+", " ", first[2]).strip().lower() != FIRST_0001:
                errors.append(("M2", rel, line_of(raw, first[0]) if first else 1, f"0001 的第一句必须是“{FIRST_0001}”"))
        # 新建函数不写 grant 不算错：0001 的全局默认权限保证 PUBLIC 执行不了（TC-B0-73 ④，D1 核对实际权限）

        # M2“紧跟”（架构 3.3 C 0.33 写法、TC-B0-73 ①）：同一文件里，F 的 grant / revoke execute 只能出现在建 F 那一句后面
        #   连着的一串里（这一串只许是对 F 的 grant / revoke execute）；中间隔了别的语句就失败
        adjacent = set()
        for i, (off, _, t) in enumerate(stmts):
            m = CREATE_FN.match(t)
            if not m:
                continue
            k = fn_key(m.group(1))
            j = i + 1
            while j < len(stmts) and k in exec_targets(stmts[j][2]):
                adjacent.add((k, stmts[j][0]))
                j += 1
        for k, offs in granted.items():
            for off in offs:
                if (k, off) not in adjacent and any(f == rel and o < off for f, o in created.get(k, [])):
                    errors.append(("M2", rel, line_of(raw, off), f"{k} 的 grant / revoke 要紧跟建函数的语句（中间不能隔别的语句）"))

    check_order(parsed, errors)
    check_grant_summary(root, parsed, errors)


APP_CONFIG = r"(\"?public\"?\s*\.\s*)?\"?app_config\"?"
FEAT_CREATE = re.compile(r"\"?\bfeatures\"?\s+jsonb\b[^,]*?\bdefault\s+", re.IGNORECASE)
FEAT_ALTER = re.compile(r"\balter\s+(?:column\s+)?\"?features\"?\s+set\s+default\s+", re.IGNORECASE)
# 默认值字面量（遮住后是 'xxx'），可带 ::jsonb；后面只能是子句结束（alter：逗号或句末；建表：逗号、右括号或下一个列约束）
FEAT_LIT_ALTER = re.compile(r"'(x*)'(?:\s*::\s*jsonb)?\s*(?=,|$)", re.IGNORECASE)
FEAT_LIT_CREATE = re.compile(r"'(x*)'(?:\s*::\s*jsonb)?\s*(?=,|\)|$|(?:not|null|check|constraint|unique|primary|references|collate)\b)", re.IGNORECASE)


def features_defaults(t, r, flat):
    """M3：一句里 app_config.features 的每个列默认值 → [(在句子里的偏移, 字面量原文或 None=不是 JSON 字面量)]。
    t 是遮住注释和字符串内容的文本，r 是原文，两者逐字对齐"""
    out = []
    if re.match(r"^create\s+table\s+(if\s+not\s+exists\s+)?" + APP_CONFIG + r"(\s|\(|$)", flat):
        rx, lit_rx = FEAT_CREATE, FEAT_LIT_CREATE
    elif re.match(r"^alter\s+table\s+(if\s+exists\s+)?(only\s+)?" + APP_CONFIG + r"(\s|$)", flat):
        rx, lit_rx = FEAT_ALTER, FEAT_LIT_ALTER
    else:
        return out
    for m in rx.finditer(t):
        lm = lit_rx.match(t, m.end())
        out.append((m.start(), r[lm.start(1):lm.end(1)] if lm else None))
    return out


def exec_targets(t):
    """grant / revoke execute on function … 里点到的函数（不含 on all functions in schema）"""
    g = EXEC_PRIV.match(t)
    if not g or re.match(r"all\s+functions\s+in\s+schema", g.group(2), re.IGNORECASE):
        return set()
    return {fn_key(fm.group(1)) for fm in re.finditer(NAME + r"\s*\(", g.group(2))}


# 9 张同步表（架构 0.29 第 29 条、4.1；数据字典 4.3b）：建表后下一句是 table_meta 行（0.29 续第 39 条），(user_id, synced_at) 索引写在建表的文件里
SYNC_TABLES = ("settings", "devices", "events", "todos", "categories", "notes", "note_images", "note_files", "anniversaries")
CREATE_TABLE = re.compile(r"^create\s+table\s+(?:if\s+not\s+exists\s+)?" + NAME, re.IGNORECASE)
META_INSERT = re.compile(r"^insert\s+into\s+private\.table_meta\b[^;]*?\bvalues\s*\(\s*'([^']+)'", re.IGNORECASE)
SYNC_INDEX = re.compile(r"^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(?:\w+\s+)?on\s+(?:only\s+)?" + NAME + r"\s*(?:using\s+\w+\s*)?\(\s*user_id\s*,\s*synced_at\s*\)", re.IGNORECASE)


def check_order(parsed, errors):
    """M5（TC-B0-73 ③）：0001 的先后——全局默认权限 → table_meta、table_meta_of()、touch() → 各表；同步表建表后下一句是它的 table_meta 行。
    M6（TC-B0-73 ⑤）：9 张同步表的 (user_id, synced_at) 索引写在建表的文件里"""
    table_file = {}
    index_files = {}
    for name, rel, raw, stmts in parsed:
        for i, (off, r, t) in enumerate(stmts):
            line = line_of(raw, off)
            ct = CREATE_TABLE.match(t)
            if ct:
                tbl = fn_key(ct.group(1))
                table_file.setdefault(tbl, (rel, line))
                short = tbl.split(".", 1)[1]
                if tbl.startswith("public.") and short in SYNC_TABLES:
                    nxt = META_INSERT.match(stmts[i + 1][1].strip()) if i + 1 < len(stmts) else None
                    if not nxt or nxt.group(1) != short:
                        errors.append(("M5", rel, line, f"{tbl} 建表后的下一句必须是它的 table_meta 行（0.29 续第 39 条）"))
            mi = META_INSERT.match(r.strip())
            if mi:
                prev = CREATE_TABLE.match(stmts[i - 1][2]) if i > 0 else None
                if not prev or fn_key(prev.group(1)) != f"public.{mi.group(1)}":
                    errors.append(("M5", rel, line, f"table_meta 的 {mi.group(1)} 行要紧跟建 public.{mi.group(1)} 的语句"))
            si = SYNC_INDEX.match(t)
            if si:
                index_files.setdefault(fn_key(si.group(1)), []).append((rel, line))

        if not name.startswith("0001_"):
            continue
        tables = [(i, fn_key(m.group(1))) for i, (_, _, t) in enumerate(stmts) if (m := CREATE_TABLE.match(t))]
        if not any(k == "private.table_meta" or k.split(".", 1)[1] in SYNC_TABLES for _, k in tables):
            continue   # 没有 table_meta 和同步表的迷你 0001（样例）不查先后
        want = [("private.table_meta", CREATE_TABLE), ("private.table_meta_of", CREATE_FN), ("private.touch", CREATE_FN)]
        pos = []
        for k, rx in want:
            hit = [i for i, (_, _, t) in enumerate(stmts) if (m := rx.match(t)) and fn_key(m.group(1)) == k]
            pos.append(hit[0] if hit else None)
        if None in pos:
            missing = "、".join(k for (k, _), p in zip(want, pos) if p is None)
            errors.append(("M5", rel, 1, f"0001 里没有 {missing}（先后：全局默认权限 → table_meta、table_meta_of()、touch() → 各表）"))
            continue
        if pos != sorted(pos):
            errors.append(("M5", rel, line_of(raw, stmts[max(pos)][0]), "0001 里 table_meta、table_meta_of()、touch() 要按这个先后写"))
        for i, k in tables:
            if k != "private.table_meta" and i < pos[2]:
                errors.append(("M5", rel, line_of(raw, stmts[i][0]), f"{k} 建在 touch() 之前：0001 的先后是全局默认权限 → table_meta、table_meta_of()、touch() → 各表"))

    for short in SYNC_TABLES:
        tbl = f"public.{short}"
        if tbl not in table_file:
            continue
        rel, line = table_file[tbl]
        if not any(f == rel for f, _ in index_files.get(tbl, [])):
            where = "、".join(f"{f}:{ln}" for f, ln in index_files.get(tbl, [])) or "没有"
            errors.append(("M6", rel, line, f"{tbl} 的 (user_id, synced_at) 索引要写在建表的文件里（现在：{where}）"))


# ---------------- M4：授权汇总和架构 3.3 C 逐行比对（TC-B0-73 ①；0.29 续第 32 条，0.33 的 3.3 C 写法） ----------------
ARCH_DOC = "docs/10-架构/架构设计-v4.md"
C_HEAD = "**C. private schema 的授权白名单**"
A_HEAD = "-- private 的授权白名单（和 3.3 C 一字不差"
A_END = "-- ===== 0.29（P-14）"
TAG_RE = re.compile(r"^\s*(000[1-7]|B\d+)")
CLIENT_ROLES = {"public", "anon", "authenticated", "service_role"}
PRIV_RE = re.compile(r"^(grant|revoke) (.*?) on (.*?) (to|from) (.*)$")


def norm_sql(s):
    s = re.sub(r"\s+", " ", s).strip().rstrip(";").strip().lower()
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s+\)", ")", s)
    s = re.sub(r"\s*,\s*", ", ", s)
    return s


def in_summary(s):
    """这一句归不归 3.3 C 的汇总管（s 已 norm_sql）。3.3 C 管：函数的默认权限；整段收回 private；private 的 schema usage；
    private 函数的 grant / revoke execute（任何角色）；private 表、视图给 public、anon、authenticated、service_role 的 grant；
    public 表给 service_role 的 grant（storage-sweep 的列级授权）。给 fn_vault、fn_ai 的表授权由 D1 和 6.2 比对（附录 A 末尾），
    对具体 private 表的 revoke 只收不放，也不在汇总里"""
    if s.startswith("alter default privileges") and " on functions " in f" {s} ":
        return True
    m = PRIV_RE.match(s)
    if not m:
        return False
    verb, _, obj, _, who = m.groups()
    grantees = {g.strip() for g in re.sub(r"\bgranted by .*$", "", who).split(",")}
    if re.match(r"all (tables|functions|sequences) in schema private\b", obj):
        return True
    if obj.startswith("schema "):
        return "private" in [x.strip() for x in obj[len("schema "):].split(",")] and bool(grantees & CLIENT_ROLES)
    if re.match(r"functions? private\.", obj):
        return True
    if verb != "grant":
        return False
    obj = re.sub(r"^table ", "", obj)
    if obj.startswith("private."):
        return bool(grantees & CLIENT_ROLES)
    if obj.startswith("public."):
        return "service_role" in grantees
    return False


def doc_lines(root):
    p = root / ARCH_DOC
    return p.read_text(encoding="utf-8").split("\n") if p.exists() else None


def summary_block(lines):
    """3.3 C 的 ```sql 段：[(文档行号, 原行, 语句, 标的文件或 None)]"""
    try:
        h = next(i for i, ln in enumerate(lines) if ln.startswith(C_HEAD))
        s = next(i for i in range(h, len(lines)) if lines[i].strip().startswith("```sql"))
        e = next(i for i in range(s + 1, len(lines)) if lines[i].strip().startswith("```"))
    except StopIteration:
        return None
    return parse_stmt_lines(lines, s + 1, e)


def appendix_block(lines):
    try:
        s = next(i for i, ln in enumerate(lines) if ln.startswith(A_HEAD))
        e = next(i for i in range(s, len(lines)) if lines[i].startswith(A_END))
    except StopIteration:
        return None
    return parse_stmt_lines(lines, s, e)


def parse_stmt_lines(lines, s, e):
    out = []
    for i in range(s, e):
        ln = lines[i].strip()
        if not ln or ln.startswith("--"):
            continue
        stmt, _, comment = ln.partition("--")
        tag = TAG_RE.match(comment)
        out.append((i + 1, ln, norm_sql(stmt), tag.group(1) if tag else None))
    return out


def check_grant_summary(root, parsed, errors):
    lines = doc_lines(root)
    if lines is None:
        return   # 样例目录里没有架构文档就不比（tests/arch-fixtures/check_backend/m4-grant-summary 带一份迷你的）
    summary = summary_block(lines)
    if summary is None:
        errors.append(("M4", ARCH_DOC, 1, "找不到 3.3 C 的授权白名单（“**C. private schema 的授权白名单**”后面的 ```sql 段）"))
        return
    for dl, _, stmt, tag in summary:
        if tag is None:
            errors.append(("M4", ARCH_DOC, dl, "3.3 C 这一行没在行尾标文件（-- 0001～0007，或 -- B1 新迁移 这类）"))
        elif not in_summary(stmt):
            errors.append(("M4", ARCH_DOC, dl, "3.3 C 这一行检查认不出归属（不是汇总管的授权语句），请核对写法"))

    # 附录 A 末尾照抄 3.3 C（复审 N2）：语句行逐行一字不差
    appendix = appendix_block(lines)
    if appendix is None:
        errors.append(("M4", ARCH_DOC, 1, f"找不到附录 A 末尾的授权白名单（“{A_HEAD}”到“{A_END}”）"))
    else:
        for k in range(max(len(summary), len(appendix))):
            a = appendix[k] if k < len(appendix) else None
            c = summary[k] if k < len(summary) else None
            if not a or not c or a[1] != c[1]:
                dl = a[0] if a else appendix[-1][0] if appendix else 1
                errors.append(("M4", ARCH_DOC, dl, f"附录 A 末尾和 3.3 C 第 {k + 1} 句不一样（要一字不差）：3.3 C 是“{c[1] if c else '（没有）'}”"))
                break

    by_stmt = {}
    for dl, _, stmt, tag in summary:
        by_stmt.setdefault(stmt, []).append((dl, tag))
    seen = {}   # (语句, 文件前缀) → 次数
    for name, rel, raw, stmts in parsed:
        prefix = name[:4] if re.match(r"^000[1-7]_", name) else None
        for off, _, t in stmts:
            s = norm_sql(t)
            if not in_summary(s):
                continue
            line = line_of(raw, off)
            hits = by_stmt.get(s)
            if not hits:
                errors.append(("M4", rel, line, "这一句授权不在架构 3.3 C 的汇总里（先改 3.3 C 和附录 A，再写迁移）"))
                continue
            tags = {tg for _, tg in hits}
            if prefix and prefix not in tags:
                errors.append(("M4", rel, line, f"3.3 C 里这一行标的是 {'、'.join(sorted(t for t in tags if t))}，实际写在 {prefix}"))
            if not prefix and not any(tg and tg.startswith("B") for tg in tags):
                errors.append(("M4", rel, line, f"3.3 C 里这一行标在 {'、'.join(sorted(t for t in tags if t))}，不该写进新迁移"))
            seen[(s, prefix)] = seen.get((s, prefix), 0) + 1
    present = {n[:4] for n, *_ in parsed if re.match(r"^000[1-7]_", n)}
    for dl, _, stmt, tag in summary:
        if tag and tag in present and seen.get((stmt, tag), 0) == 0:
            errors.append(("M4", ARCH_DOC, dl, f"3.3 C 这一行标在 {tag}，{tag} 里没有这一句"))
        if tag and tag in present and seen.get((stmt, tag), 0) > 1:
            errors.append(("M4", ARCH_DOC, dl, f"3.3 C 这一行在 {tag} 里写了 {seen[(stmt, tag)]} 次"))


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parent.parent))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--print-preview-funcs", action="store_true")
    # 只给样例测试用（tests/build/check-backend.test.ts）：把这些名字当作预览专用函数（同时能用 R2、能经 db.ts 用 fn_ai），
    # 证明名单里的函数照规则放行。不能和 --print-preview-funcs 一起用（deploy-preview.yml、publish.ps1 读的名单只能是上面那一份）
    ap.add_argument("--sample-preview-funcs", default=None)
    args = ap.parse_args(argv)
    if args.sample_preview_funcs is not None:
        if args.print_preview_funcs:
            print("--sample-preview-funcs 不能和 --print-preview-funcs 一起用", file=sys.stderr)
            return 2
        global PREVIEW_FUNCS, PREVIEW_R2_FUNCS, PREVIEW_AI_FUNCS
        names = frozenset(n for n in args.sample_preview_funcs.split(",") if n)
        # 三个名单一起换（db-probe 安全审查必改 4）：样例不靠真名单，真名单清空后样例照样跑
        PREVIEW_FUNCS = PREVIEW_R2_FUNCS = PREVIEW_AI_FUNCS = names
    if args.print_preview_funcs:
        for n in sorted(PREVIEW_FUNCS):
            print(n)
        return 0
    root = pathlib.Path(args.root).resolve()

    errors = []
    check_functions(root, errors)
    check_pages(root, errors)
    check_migrations(root, errors)
    errors = sorted(set(errors), key=lambda e: (e[1], e[2], e[0], e[3]))
    # 同一处同一条规则只报一次
    seen, uniq = set(), []
    for e in errors:
        if (e[0], e[1], e[2]) not in seen:
            seen.add((e[0], e[1], e[2]))
            uniq.append(e)

    if args.json:
        print(json.dumps({"errors": [{"rule": r, "file": f, "line": ln, "message": m} for r, f, ln, m in uniq]}, ensure_ascii=False))
    else:
        for r, f, ln, m in uniq:
            print(f"错误 {r} {f}:{ln} {m}")
        print(f"check_backend：{len(uniq)} 个错误")
    return 1 if uniq else 0


if __name__ == "__main__":
    sys.exit(main())
