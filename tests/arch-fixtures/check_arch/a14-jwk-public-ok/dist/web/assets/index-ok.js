// 对照 A14：压缩 JSON 里只有公钥（不报）；d 的值不是 43 个字符（42、44）也不报
var p={"kty":"EC","crv":"P-256","x":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","y":"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"};var q={"kty":"oct","d":"dddddddddddddddddddddddddddddddddddddddddd"};var r={"kty":"EC","d":"dddddddddddddddddddddddddddddddddddddddddddxx"};
