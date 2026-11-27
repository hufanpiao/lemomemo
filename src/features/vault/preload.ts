// 隐私记的后台预加载（vault/index.ts 的 preload 引这个文件）：
// App 首屏画完、空闲时 app/features.ts 的 preloadPages 下载一次，模块第一次求值时：
// • 隐私记页的代码一起下载（静态引 ui/VaultPage.tsx，点进去时不再等下载）；
// • 还没查过隐私记状态就先查一次（hooks/useVault.ts 的 warmVault，顺带叫醒 vault 函数）。
// 只查状态，不碰令牌和明文。模块只求值一次，一次启动只查这一次
import { warmVault } from './hooks/useVault.ts';
import VaultPage from './ui/VaultPage.tsx';

warmVault();

export default VaultPage;
