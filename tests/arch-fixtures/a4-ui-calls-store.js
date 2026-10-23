// @fixture 路径=src/scripts/ui/bad-save.js 期望=A4
// 职责：故意违规示例：界面绕过 data/write.js 直接写存储
// 依赖：data/store.js
const store = App.data.store;
App.ui.badSave = x => store.update("todos", x.id, {done:true});
