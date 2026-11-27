// 对照 A14（架构 0.51 第 2 条）：只有公钥（kty、x、y，没有 d）不报；id、kid 这类键名里含 d 的也不算 d 键
export const pub = { kty: 'EC', crv: 'P-256', kid: 'ddddddddddddddddddddddddddddddddddddddddddd', id: 'ddddddddddddddddddddddddddddddddddddddddddd', x: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', y: 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' };
// 对照 A14（B2 代码审查 S1）：转义写法、只有公钥（没有 \"d\"）不报
export const pubEscaped = "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\",\"y\":\"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\"}";
