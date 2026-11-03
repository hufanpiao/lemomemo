// 违规 A14（架构 0.51 第 2 条；B2 代码审查 S1）：JWK 私钥整串放在一个字符串里，引号转义成 \"（假值，低熵的 x/y/d，不对应任何真实钥匙）
export const raw = "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"ddddddddddddddddddddddddddddddddddddddddddd\",\"x\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\",\"y\":\"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\"}";
