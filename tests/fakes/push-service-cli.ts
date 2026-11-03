// 本机推送替身的命令行入口：替身要跑在另一个进程里时用（例如手动联调、函数跑在别的进程里）。参数见 push-service.ts 的 parseFakePushArgs。
//   node tests/fakes/push-service-cli.ts --port 9230 --reply 410
//   node tests/fakes/push-service-cli.ts --delay 3000              （D3 第 6 点：每个请求拖 3 秒）
//   deno run --allow-net=127.0.0.1 --allow-env=FAKE_PUSH_PORT tests/fakes/push-service-cli.ts --reply hang
//   （Deno 读 process.env 要 --allow-env；端口只能是 0 或 1024～65535）
// 启动后往 stdout 打一行 JSON：{ origin, docker, requests }。宿主机上跑的函数把 origin 填给 PUSH_SERVICE_OVERRIDE_URL，
// 容器里的 edge runtime 填 docker（http://host.docker.internal:<端口>；替身仍只听 127.0.0.1，安全审查 1.5 第 ② 点）；
// 记录经 GET <origin>/__fake/requests 取，POST /__fake/reset 清记录，POST /__fake/config 改默认回复、拖延和规则。Ctrl+C 退出
import process from 'node:process';
import { createFakePush, parseFakePushArgs } from './push-service.ts';

const { port, options } = parseFakePushArgs(process.argv.slice(2), process.env);
const fake = createFakePush(options);
const origin = await fake.listen(port);
console.log(JSON.stringify({ origin, docker: fake.overrideUrl('host.docker.internal'), requests: `${origin}/__fake/requests` }));
const stop = () => {
  void fake.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
