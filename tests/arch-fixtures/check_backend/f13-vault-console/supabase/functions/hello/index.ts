// F13 样例：别的函数里直接 console 也报（第三方审查后端-4 起）
export const log = (c: string) => console.error(`hello: ${c}`);
