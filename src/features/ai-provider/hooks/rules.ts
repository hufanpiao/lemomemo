// 界面要用的几条规则（ui 不能直接引 data，经这里转一手；规则本身在 ../data/rules.ts）
export {
  ADMIN_ROWS, clockParts, DEFAULT_PROVIDER, type AdminRow, isKeyOwner, isOn, isProvider, isWebProvider, missingOf, needsModel, otherFails, ownSplit, pickList, pickState, routeOf, routeWritable, secOf,
  toggleWeb, type PickName, type PickState,
} from '../data/rules.ts';
export type { ProvErr } from '../data/provider-api.ts';
