// B1 K6：换账号清本机（架构 4.1、0.38 第 17 条）的端到端——已搬到真后端组（E2E-REAL 第 5 步，10-30）：
//   tests/e2e/b1-account-switch.real.spec.ts（npm run e2e:real 跑，/sb 接 lemo-e2e）
// 原来这里的两条 test.fixme（“A 登录有数据 → 换成 B → 看不到 A 的行、A 的 outbox 没发到服务器”“别的标签页换了账号：storage 事件后清库并重新载入”）
// 在那边写成了三条：注入格式的对照（不换账号时 outbox 真发到服务器）、同一个标签页换账号、别的标签页换账号。偏差写在那个文件的文件头。
// 无后端组（这一组接假后端，没有真登录、没有 RLS）不再放这件事的用例；本文件只留这段说明，不含用例。
// 单元测试仍覆盖四个判断时机和清库内容：src/core/__tests__/account.test.ts、boot.test.ts，src/platform/__tests__/session.test.ts。
export {};
