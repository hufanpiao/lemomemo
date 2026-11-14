// MOTION-IMPL 违规样例：import { type X } 不算纯类型（verbatimModuleSyntax 下会留下 import 'motion/react'）
import { type FeatureBundle } from 'motion/react';
export type B = FeatureBundle;
