// 违规 A14（架构 0.51 第 2 条）：源码里的 JWK 私钥对象字面量，键名不带引号、冒号前后有空格、值用单引号（假值，低熵的 x/y/d，不对应任何真实钥匙）
export const vapid = {
  kty : 'EC',
  crv: 'P-256',
  x: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  y: 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
  d : 'ddddddddddddddddddddddddddddddddddddddddddd',
};
