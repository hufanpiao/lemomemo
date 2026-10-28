// A27：功能的 index.ts 只能导出懒加载的东西、常量登记、类型和数据清单的引用（架构 2.1、2.3）
// • 不准值导入自己的 ui/、hooks/、data/、i18n/（只能在 lazy(() => import(...)) 里动态引入）
// • 不准 export … from（类型和 ./data.manifest.ts 除外），不准 export *
// • 导出的值只能是字面量、数组、对象、lazy(() => import('./…'))；函数、类、变量引用都不行
// • plusAdapter: () => import('./plus-adapter.ts') 只有 vault 能导出（0.23 M1）
const INNER = /^\.\/(ui|hooks|data|i18n)(\/|$)/;
const MANIFEST = /^\.\/data\.manifest(\.ts)?$/;

function featureOf(filename) {
  const m = /[\\/]src[\\/]features[\\/]([^\\/]+)[\\/]index\.ts$/.exec(filename);
  return m ? m[1] : null;
}

function unwrap(node) {
  let n = node;
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression')) {
    n = n.expression;
  }
  return n;
}

/** () => import('./…')，只许引自己文件夹里的东西 */
function isLazyImportArrow(node) {
  const n = unwrap(node);
  if (!n || n.type !== 'ArrowFunctionExpression' || n.params.length > 0) return false;
  const body = n.body;
  return (
    body.type === 'ImportExpression' &&
    body.source.type === 'Literal' &&
    typeof body.source.value === 'string' &&
    body.source.value.startsWith('./')
  );
}

/** lazy(() => import('./…')) 或 React.lazy(...) */
function isLazyCall(node) {
  const n = unwrap(node);
  if (!n || n.type !== 'CallExpression' || n.arguments.length !== 1) return false;
  const c = n.callee;
  const isLazy =
    (c.type === 'Identifier' && c.name === 'lazy') ||
    (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === 'lazy');
  return isLazy && isLazyImportArrow(n.arguments[0]);
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A27：功能 index.ts 只能导出懒加载页面、登记常量、类型和数据清单引用' },
    schema: [],
    messages: {
      valueImport: 'A27：index.ts 不准直接 import {{src}}，页面和组件要用 lazy(() => import(...))',
      reexport: 'A27：index.ts 不准 export … from {{src}}（只有类型和 ./data.manifest.ts 可以）',
      exportAll: 'A27：index.ts 不准 export *',
      badValue: 'A27：index.ts 导出的 {{name}} 只能是字面量、数组、对象或 lazy(() => import(...))',
      badDecl: 'A27：index.ts 不准导出函数或类（{{name}}）',
      plusAdapter: 'A27：plusAdapter 只有 vault 能导出，且必须是 () => import(...)',
      defaultExport: 'A27：index.ts 不准默认导出',
    },
  },
  create(context) {
    const feature = featureOf(context.filename);
    if (!feature) return {};

    function checkValue(node, name, inPlusAdapter) {
      const n = unwrap(node);
      if (!n) return true;
      switch (n.type) {
        case 'Literal':
          return true;
        case 'TemplateLiteral':
          return n.expressions.length === 0;
        case 'Identifier':
          return n.name === 'undefined';
        case 'ArrayExpression':
          return n.elements.every((el) => el === null || (el.type !== 'SpreadElement' && checkValue(el, name, false)));
        case 'ObjectExpression':
          return n.properties.every((p) => {
            if (p.type !== 'Property' || p.computed) return false;
            const key = p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
            if (key === 'plusAdapter') return checkPlusAdapter(p.value, p);
            return checkValue(p.value, name, false);
          });
        case 'CallExpression':
          return isLazyCall(n);
        case 'ArrowFunctionExpression':
          return inPlusAdapter && isLazyImportArrow(n);
        default:
          return false;
      }
    }

    function checkPlusAdapter(value, reportNode) {
      if (feature !== 'vault' || !isLazyImportArrow(value)) {
        context.report({ node: reportNode, messageId: 'plusAdapter' });
      }
      return true; // 已单独报过，不再报 badValue
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const src = String(node.source.value);
        const allType = node.specifiers.length > 0 && node.specifiers.every((s) => s.importKind === 'type');
        if (INNER.test(src) && !allType) context.report({ node, messageId: 'valueImport', data: { src } });
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        context.report({ node, messageId: 'exportAll' });
      },
      ExportDefaultDeclaration(node) {
        context.report({ node, messageId: 'defaultExport' });
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        if (node.source) {
          const src = String(node.source.value);
          const allType = node.specifiers.every((s) => s.exportKind === 'type');
          if (!allType && !MANIFEST.test(src)) context.report({ node, messageId: 'reexport', data: { src } });
          return;
        }
        const decl = node.declaration;
        if (!decl) {
          // export { a, b }：引用本地变量，等同导出变量引用
          for (const s of node.specifiers) {
            if (s.exportKind !== 'type') {
              const name = s.exported.type === 'Identifier' ? s.exported.name : String(s.exported.value);
              context.report({ node: s, messageId: 'badValue', data: { name } });
            }
          }
          return;
        }
        if (decl.type === 'TSTypeAliasDeclaration' || decl.type === 'TSInterfaceDeclaration') return;
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration' || decl.type === 'TSEnumDeclaration') {
          context.report({ node: decl, messageId: 'badDecl', data: { name: decl.id ? decl.id.name : '?' } });
          return;
        }
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            const name = d.id.type === 'Identifier' ? d.id.name : '?';
            if (name === 'plusAdapter') {
              checkPlusAdapter(d.init, d);
              continue;
            }
            if (!checkValue(d.init, name, false)) context.report({ node: d, messageId: 'badValue', data: { name } });
          }
        }
      },
    };
  },
};
