// 违规 F7（第五轮必改 2、3）：vm、child_process、worker_threads 一律不准引
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import * as wt from 'node:worker_threads';
export const a = [vm, execSync, wt];
