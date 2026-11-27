// publish-run*.test.ts 用的假发布包（B7a 起 publish.ps1 下载 CI 的产物部署，不在本机构建）：照 release-build.yml 的“发布包”
// 和 deploy-preview.yml 的 preview-bundle 现做一份 zip，内容和 CI 出的结构一样——
//   dist/web：假网页 index.html、app/version.json（正式是 <VERSION>，预览是 <VERSION>-preview.<运行号>）、打包好的 _worker.js/index.js；
//   supabase：演练仓库里被 git 跟踪的文件（正式只带 config.toml、migrations、functions、templates，去掉 functions/.env.example；预览是整个 supabase/），
//             _shared/gen 由真 node 跑演练仓库的 build/copy_shared.mjs 生成到包里（不连网）；
//             预览另加 deploy-preview 生成的预览专用函数入口（一行 import）和 config.toml 末尾的 [functions.<名>] verify_jwt = false；
//   SHA256SUMS：每行“SHA-256␠␠相对路径”，按路径 UTF-8 字节排序（和 CI 同一个格式，总指纹 = 这份清单的 SHA-256）。
// mutate：写 SHA256SUMS 之前（before）或之后（after）改一下暂存目录，模拟 CI 出错或下载以后被换。没有 mutate 的按“种类 + 提交”缓存。
// 不是测试文件，不起 PowerShell。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type PackKind = 'production' | 'preview';
export type PackMutate = { before?: (stage: string) => void; after?: (stage: string) => void };
export type Pack = { zip: string; count: number; total: string; stage: string };

const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const cache = new Map<string, Pack>();

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}：${r.stdout}${r.stderr}`);
  return r.stdout;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 暂存目录里除 SHA256SUMS 以外的全部文件写成清单（和 publish.ps1 的 Get-DistHash、build/ci/dist_hash.py 同一个算法） */
export function writeSums(stage: string): { count: number; total: string } {
  const rows = walk(stage).map((p) => relative(stage, p).split('\\').join('/')).filter((r) => r !== 'SHA256SUMS')
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const text = rows.map((r) => `${sha256(readFileSync(join(stage, r)))}  ${r}\n`).join('');
  writeFileSync(join(stage, 'SHA256SUMS'), text, 'utf8');
  return { count: rows.length, total: sha256(text) };
}

/** 演练仓库（repo）当前 HEAD 的发布包；ver 是 VERSION，runNo 是预览运行号 */
export function artifactZip(p: { dir: string; repo: string; ver: string; runNo: number; kind: PackKind; mutate?: PackMutate | undefined }): Pack {
  const { dir, repo, ver, runNo, kind, mutate } = p;
  const commit = run('git', ['rev-parse', 'HEAD'], repo).trim();
  const key = `${kind}:${commit}`;
  const hit = cache.get(key);
  if (!mutate && hit) return hit;
  const stage = mkdtempSync(join(dir, `stage-${kind}-`));
  const web = join(stage, 'dist', 'web');
  mkdirSync(join(web, 'app'), { recursive: true });
  mkdirSync(join(web, '_worker.js'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>x</title>\n', 'utf8');
  writeFileSync(join(web, 'app', 'version.json'), JSON.stringify({ version: kind === 'preview' ? `${ver}-preview.${runNo}` : ver }), 'utf8');
  writeFileSync(join(web, '_worker.js', 'index.js'), 'export default { fetch() { return new Response("x"); } };\n', 'utf8');
  const scope = kind === 'preview' ? ['supabase'] : ['supabase/config.toml', 'supabase/migrations', 'supabase/functions', 'supabase/templates'];
  const files = run('git', ['-c', 'core.quotepath=false', 'ls-files', '--', ...scope], repo).split('\n').map((l) => l.trim())
    .filter((l) => l !== '' && l !== 'supabase/functions/.env.example');
  for (const f of files) {
    const to = join(stage, f);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(repo, f), to);
  }
  run('node', [join(repo, 'build', 'copy_shared.mjs'), join(stage, 'supabase', 'functions', '_shared', 'gen')], repo);
  if (kind === 'preview') {
    const names = run('python', ['-I', 'build/check_backend.py', '--print-preview-funcs'], repo).split('\n').map((l) => l.trim()).filter(Boolean);
    for (const n of names) {
      mkdirSync(join(stage, 'supabase', 'functions', n), { recursive: true });
      writeFileSync(join(stage, 'supabase', 'functions', n, 'index.ts'), `// 由 deploy-preview.yml 在预览产物里生成，不进仓库。源码在 ../_preview/${n}/\nimport '../_preview/${n}/index.ts';\n`, 'utf8');
      appendFileSync(join(stage, 'supabase', 'config.toml'), `\n[functions.${n}]\nverify_jwt = false\n`, 'utf8');
    }
  }
  mutate?.before?.(stage);
  const sums = writeSums(stage);
  mutate?.after?.(stage);
  const zip = join(dir, `pub-${kind}-${Math.random().toString(36).slice(2, 10)}.zip`);
  run(join(SYS32, 'tar.exe'), ['-a', '-c', '-f', zip, '-C', stage, 'dist', 'supabase', 'SHA256SUMS'], stage);
  const pack = { zip, ...sums, stage };
  if (!mutate) cache.set(key, pack);
  return pack;
}
