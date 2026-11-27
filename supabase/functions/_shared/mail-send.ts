// 经 Resend 发信只在这里做（架构约定 10.1）：官方地址、发件人、超时、不跟重定向。account、account-purge、invite-signup 共用。
// 不 import npm 包、不读环境变量；key 和地址由各 index.ts 传进来。
import { postOut } from './net.ts';

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
/** 5.6：发件人 noreply@lemomemo.com */
export const MAIL_FROM = '柠檬记 <noreply@lemomemo.com>';

/** 发一封纯文本信；Resend 回 2xx 才算发出。网络错、超时照常抛错，由调用方按“没发出去”处理 */
export async function sendMail(apiKey: string, to: string, mail: { subject: string; text: string }, url: string = RESEND_EMAILS_URL): Promise<boolean> {
  const r = await postOut((u, i) => fetch(u, i), url, {
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: mail.subject, text: mail.text }),
  });
  await r.body?.cancel();
  return r.ok;
}
