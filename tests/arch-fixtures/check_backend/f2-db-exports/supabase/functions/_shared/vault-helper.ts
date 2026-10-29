// 共用模块把 withVaultUser 改名转手出去（本身不报；引它的函数按 fn_vault 查）
export { withVaultUser as helper } from './db.ts';
