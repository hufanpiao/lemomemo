// 违规 A14：同一个 dist 文件里同时有 publishable 和 secret、sbp_，放行只跳过 publishable 那一条规则，secret、sbp_ 照报（假值，低熵的 x）
const a="sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",b="sb_secret_xxxxxxxxxxxxxxxxxxxxxxxx",c="sbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";export{a,b,c};
