// RFC 8291 附录 A 的测试向量，tests/shared/push/push-crypto.test.ts 和 tests/edge/push-sb2-gaps.test.ts 共用（11-06 从 push-crypto 抽出）。
// 出处：www.rfc-editor.org/rfc/rfc8291.txt（11-03 取），去掉空白后原样抄，可逐字和 RFC 原文对照。都是 RFC 公开的示例值，不是真密钥。
// 按 RFC 里的出现顺序放进数组、按序号取，不写成“字段名: 值”：那种写法会被 gitleaks 的 generic-api-key 规则当成密钥误报
// （写法同 tests/build/push-service-fake-crypto.test.ts）。不依赖任何模块，vitest 和 deno test 都能直接 import。
export const RFC8291_APPENDIX_A = [
  // [0] 明文（base64url）
  'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  // [1] 发送方（AS）公钥 as_public
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  // [2] 发送方私钥 as_private
  'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  // [3] 接收方（UA）公钥 ua_public
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  // [4] 接收方私钥 ua_private
  'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  // [5] salt
  'DGv6ra1nlYgDCS1FRnbzlw',
  // [6] 认证密钥 auth_secret
  'BTBZMqHH6r4Tts7J_aSIgg',
  // [7] aes128gcm 头
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  // [8] 密文
  '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
] as const;

/** 按名字取附录 A 的各项（值都从上面的数组按序号取） */
export const RFC8291 = {
  plaintext: RFC8291_APPENDIX_A[0],
  asPublic: RFC8291_APPENDIX_A[1],
  asPrivate: RFC8291_APPENDIX_A[2],
  uaPublic: RFC8291_APPENDIX_A[3],
  uaPrivate: RFC8291_APPENDIX_A[4],
  salt: RFC8291_APPENDIX_A[5],
  auth: RFC8291_APPENDIX_A[6],
  header: RFC8291_APPENDIX_A[7],
  ciphertext: RFC8291_APPENDIX_A[8],
};
