// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=常量链接不安全 rule=A26 count=14
// 违规（A26-old-gaps ④）：链接类属性写成常量也要过协议检查，只准相对地址和 http、https、tel、mailto；
// 大小写、开头空格、中间的制表符（JSX 里 &#9; 会解码成制表符，浏览器解析 URL 时删掉）都照浏览器的做法处理。
// 第十批审查建议：和 safeHref 一致，另挡协议相对地址（//、\\、/\ 开头，会去别的站）和带用户名、密码的地址
export const Bad = () => (
  <>
    <a href="javascript:alert(1)">a</a>
    <a href={'JavaScript:alert(1)'}>b</a>
    <a href={`vbscript:msgbox(1)`}>c</a>
    <a href=" java&#9;script:alert(1)">d</a>
    <iframe title="x" src="data:text/html,hi" />
    <img alt="" srcSet="ok.png 1x, javascript:alert(1) 2x" />
    <a {...{ href: 'javascript:alert(1)' }}>e</a>
    <form action="javascript:alert(1)" />
    <a href="//evil.example/x">f</a>
    <a href={'\\\\evil.example/x'}>g</a>
    <a href={'/\\evil.example/x'}>h</a>
    <a href="https://lemomemo.com@evil.example/">i</a>
    <a href="https://user:pw@lemomemo.com/">j</a>
    <img alt="" src="https://lemomemo.com@evil.example/a.png" />
  </>
);
