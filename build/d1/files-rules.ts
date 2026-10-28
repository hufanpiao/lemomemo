// D1 的“/files 规则表和清单一致”（架构 0.32 第 9 条；3.5 第 4 点；任务单 BE-4；TC-B0-118 第三份样例）
// 规则表 functions/_generated/files-rules.ts 由前端 B 的 build/gen_files_rules.mjs 按清单生成（FB-2），这里不管它的写法，只核对两件事：
//   ① 内容：客户端可传的 R2 桶（CLIENT_FILE_BUCKETS）每一段登记的 pathPattern、桶主人的大小上限和每个 MIME 都原样出现在生成物里
//      （pathPattern 认原样或 JSON 转义两种写法）；文件头有“自动生成，不要手改”。手改其中任何一个字都会失败
//   ② 逐字：生成器导出 renderFilesRules(manifests) 时，用它重新生成一遍，和仓库里的逐字比（FB-2 的“CI 重新生成后和仓库比”在 D1 里再做一次）
// 生成物不在时：/files 函数（functions/files/）也不在就只记一条说明（前端 B 还没合进来）；函数在、规则表不在就失败
// 纯函数，不读文件：读文件的是两个入口（build/check_data_manifest.ts、supabase/tests/offline/run.mjs）
import type { Manifest } from '../../shared/schema/manifest.ts';
import { CLIENT_FILE_BUCKETS } from '../../shared/manifests/_common.ts';

export const FILES_RULES_PATH = 'functions/_generated/files-rules.ts';
export const FILES_FUNCTION_DIR = 'functions/files';
export const GENERATED_HEADER = '自动生成，不要手改';

export type FilesRulesInput = {
  /** 仓库里 functions/_generated/files-rules.ts 的内容；不在时为 null */
  generated: string | null;
  /** functions/files/ 在不在（/files 函数） */
  functionExists: boolean;
  /** build/gen_files_rules.mjs 导出的 renderFilesRules；生成器还没有、或没导出时不传 */
  render?: ((manifests: readonly Manifest[]) => string) | undefined;
};

export type FilesRulesResult = { problems: string[]; notes: string[] };

/** 规则表必须带上的内容（D1 自己从清单推出来，不依赖生成器） */
export function filesRulesFacts(manifests: readonly Manifest[]): { what: string; forms: string[] }[] {
  const names: readonly string[] = CLIENT_FILE_BUCKETS;
  const facts: { what: string; forms: string[] }[] = [];
  for (const m of manifests) for (const b of m.buckets) {
    if (!names.includes(b.name) || b.store !== 'r2') continue;
    // 原样、正则字面量（/ 写成 \/）或 JSON 转义（字符串里的反斜杠写成两个）
    facts.push({ what: `${b.name} 的 pathPattern（${m.feature}）${b.pathPattern}`,
      forms: [b.pathPattern, b.pathPattern.replace(/\//g, '\\/'), JSON.stringify(b.pathPattern).slice(1, -1)] });
    if (!b.limits) continue;
    const n = b.limits.fileSizeLimit;
    facts.push({ what: `${b.name} 的大小上限 ${n}`, forms: [String(n), String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_')] });
    for (const t of b.limits.allowedMimeTypes) facts.push({ what: `${b.name} 的类型 ${t}`, forms: [`'${t}'`, `"${t}"`] });
  }
  return facts;
}

export function checkFilesRules(input: FilesRulesInput, manifests: readonly Manifest[]): FilesRulesResult {
  const problems: string[] = [], notes: string[] = [];
  const { generated } = input;
  if (generated === null) {
    if (input.functionExists) problems.push(`${FILES_FUNCTION_DIR}/ 在，${FILES_RULES_PATH} 却不在：跑 build/gen_files_rules.mjs 生成后提交`);
    else notes.push(`${FILES_RULES_PATH} 和 ${FILES_FUNCTION_DIR}/ 都还没有（前端 B 的 FB-2、FB-3），规则表核对跳过`);
    return { problems, notes };
  }
  const head = generated.split('\n').slice(0, 5).join('\n');
  if (!head.includes(GENERATED_HEADER)) problems.push(`${FILES_RULES_PATH} 的文件头没有“${GENERATED_HEADER}”`);
  for (const f of filesRulesFacts(manifests)) {
    if (!f.forms.some((x) => generated.includes(x))) problems.push(`${FILES_RULES_PATH} 和清单不一致：找不到 ${f.what}`);
  }
  if (input.render) {
    const want = input.render(manifests).replace(/\r\n/g, '\n');
    if (want !== generated.replace(/\r\n/g, '\n')) {
      const a = want.split('\n'), b = generated.replace(/\r\n/g, '\n').split('\n');
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      problems.push(`${FILES_RULES_PATH} 和按清单重新生成的不一致（第 ${i + 1} 行起）：改了清单要重跑 build/gen_files_rules.mjs，不能手改`);
    }
  } else {
    notes.push('build/gen_files_rules.mjs 还没有、或没导出 renderFilesRules，只核对了内容，没逐字比');
  }
  return { problems, notes };
}
