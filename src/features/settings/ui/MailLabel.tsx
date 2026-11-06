// 长邮箱的断行（韩文复审建议，不再断成“test.a / ccount”）：在“@”前、“.”后插 <wbr>，优先在这些地方断；
// 一段本身比一行还长时才由外层的 overflow-wrap 在中间断。设置首页“账号”一行和账号二级页最上面那行邮箱共用（合卡代码审查 S5）
import { Fragment } from 'react';

export function MailLabel({ mail }: { mail: string }) {
  return (
    <>
      {mail.split(/(?=@)|(?<=\.)/u).map((part, i) => (
        <Fragment key={`${String(i)}:${part}`}>
          {i > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}
