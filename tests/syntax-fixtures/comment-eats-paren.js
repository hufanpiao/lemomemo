// 故意写错语法的示例（期望行=8）：复现 v3 里真实出过的错误——第 7 行的行尾注释写在了“});”前面，把右括号吃掉了；
// Node 读到第 8 行才发现少了括号，所以报在第 8 行。职责：证明 build/check_js.py 能拦住这类错误并报出行号（python build/check_js.py --self-test）。
// 依赖：无。本文件不在 manifest 里，不会进构建。
const on = (type, fn) => fn;
const toast = {show(){}};
function init(){
  on("error", e => { toast.show("没保存上", "重试", e.retry, 0);   // 不自动消失 });
}
