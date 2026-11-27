// 手指下的真系统开关问“这一下要不要震”（platform/fx-api.ts 的 takeBuzz）：kit 的组件按边界规则引不到 platform，
// TapSwitch、CheckCircle 从这里拿（kit 的 hooks 能碰 platform）
export { takeBuzz } from '../../platform/fx-api.ts';
