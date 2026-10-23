// @fixture 路径=src/scripts/data/bad-toast.js 期望=A2
// 职责：故意违规示例：data 层直接弹提示、改 DOM（应该发事件，由界面订阅）
// 依赖：data/bus.js
App.data.badToast = (li) => { li.classList.add("done"); App.ui.toast.show("完成了"); };
