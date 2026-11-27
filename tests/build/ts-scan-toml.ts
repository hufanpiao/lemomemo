// tests/build/ts-scan.ts 的 config.toml 部分（从 ts-scan.ts 拆出，免得超过 max-lines；ts-scan.ts 转出这两个函数）：
// 只认覆盖核对用得到的子集——段落、点号键、内联表。正反例在 tests/build/ts-scan.test.ts 的“config.toml”一组。

function splitKey(k: string): string[] {
  const out: string[] = [], re = /\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < k.length && (m = re.exec(k))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** 在引号、括号外找第一个 ch（at 处开始） */
function topIndex(s: string, ch: string): number {
  let q = '', depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k] ?? ''; if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === '\'') q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ch && depth === 0) return k;
  }
  return -1;
}

/** config.toml 里声明的函数：名字 → { 键: 原样的值 }（[functions.x]、[functions] 下 x.k = v、x = { k = v }、根上 functions = { x = { … } }） */
export function tomlFunctions(toml: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const ensure = (path: string[]) => {
    const nm = path[0] === 'functions' ? path[1] : undefined;
    if (nm !== undefined && !out.has(nm)) out.set(nm, new Map());
    return nm === undefined ? undefined : out.get(nm);
  };
  const put = (path: string[], raw: string) => {
    const v = raw.trim(), kv0 = ensure(path);
    if (v.startsWith('{') && v.endsWith('}')) {
      let body = v.slice(1, -1);
      while (body.trim() !== '') {
        const comma = topIndex(body, ','), kv = comma < 0 ? body : body.slice(0, comma), eq = topIndex(kv, '=');
        if (eq > 0) put([...path, ...splitKey(kv.slice(0, eq))], kv.slice(eq + 1));
        body = comma < 0 ? '' : body.slice(comma + 1);
      }
      return;
    }
    if (path.length >= 3) kv0?.set(path.slice(2).join('.'), v);
  };
  let section: string[] = [];
  for (const raw of toml.split('\n')) {
    const hash = topIndex(raw, '#'), line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (!line) continue;
    if (line.startsWith('[[')) { section = ['[[]]']; continue; }
    const sec = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (sec) { section = splitKey(sec[1] ?? ''); ensure(section); continue; }
    const eq = topIndex(line, '=');
    if (eq > 0) put([...section, ...splitKey(line.slice(0, eq))], line.slice(eq + 1));
  }
  return out;
}

/** config.toml 里 verify_jwt = true 的函数 */
export function verifyJwtTrue(toml: string): Set<string> {
  return new Set([...tomlFunctions(toml)].filter(([, kv]) => kv.get('verify_jwt') === 'true').map(([nm]) => nm));
}
