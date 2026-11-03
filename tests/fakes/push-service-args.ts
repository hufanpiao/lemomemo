// 本机推送替身的命令行参数解析（push-service-cli.ts 用；单独放一个文件便于单测，push-service.ts 再导出）
import { type FakePushOptions, type PushReply, REDIRECT_TARGET, reply } from './push-service-types.ts';

export interface FakePushCliConfig {
  port: number;
  options: FakePushOptions;
}

const CLI_USAGE =
  '用法：node tests/fakes/push-service-cli.ts [--port N] [--reply 201|404|410|429|301|302|303|307|308|hang|<状态码>] ' +
  '[--retry-after 秒] [--location 地址] [--delay 毫秒] [--vapid] [--vapid-aud 源]… [--vapid-key 公钥] [--vapid-report-only]';

/** 解析命令行；端口不写时读 env.FAKE_PUSH_PORT，再没有就 0（随机）。配错的回复（如 --reply 99）在这里就报错 */
export function parseFakePushArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): FakePushCliConfig {
  const take = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 后面要跟值。${CLI_USAGE}`);
    return v;
  };
  const int = (s: string, name: string): number => {
    if (!/^\d+$/.test(s)) throw new Error(`${name} 要写非负整数：${s}`);
    return Number(s);
  };
  let port = env.FAKE_PUSH_PORT !== undefined && env.FAKE_PUSH_PORT !== '' ? int(env.FAKE_PUSH_PORT, 'FAKE_PUSH_PORT') : 0;
  let kind = '201';
  let retryAfter = '30';
  let location: string = REDIRECT_TARGET;
  let delayMs = 0;
  let vapid = false;
  let reportOnly = false;
  let key: string | undefined;
  const auds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port': port = int(take(i, a), a); i++; break;
      case '--reply': kind = take(i, a); i++; break;
      case '--retry-after': retryAfter = take(i, a); i++; break;
      case '--location': location = take(i, a); i++; break;
      case '--delay': delayMs = int(take(i, a), a); i++; break;
      case '--vapid': vapid = true; break;
      case '--vapid-report-only': vapid = true; reportOnly = true; break;
      case '--vapid-aud': vapid = true; auds.push(take(i, a)); i++; break;
      case '--vapid-key': vapid = true; key = take(i, a); i++; break;
      default: throw new Error(`不认识的参数：${a}。${CLI_USAGE}`);
    }
  }
  // 0 是随机分配；指定的话要在 1024～65535（D1-8 只认这个范围的替身地址，代码审查 S2）
  if (port !== 0 && (port < 1024 || port > 65535)) throw new Error(`端口要是 0 或 1024～65535：${port}`);
  let defaultReply: PushReply;
  if (kind === 'hang') defaultReply = reply.hang();
  else if (kind === '201') defaultReply = reply.created();
  else if (kind === '429') defaultReply = reply.tooMany(/^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter);
  else if (/^30[12378]$/.test(kind)) defaultReply = reply.redirect(location, Number(kind) as 301 | 302 | 303 | 307 | 308);
  else if (/^[1-5]\d\d$/.test(kind) && Number(kind) >= 200) defaultReply = reply.status(Number(kind));
  else throw new Error(`--reply 不认识：${kind}。${CLI_USAGE}`);
  const options: FakePushOptions = { defaultReply, delayMs, control: true };
  if (vapid) {
    options.vapid = {
      ...(reportOnly ? { enforce: false } : {}),
      ...(auds.length > 0 ? { audienceOk: (aud: string) => auds.includes(aud) } : {}),
      ...(key !== undefined ? { publicKey: key } : {}),
    };
  }
  return { port, options };
}
