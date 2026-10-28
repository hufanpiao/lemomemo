// arch-fixture: path=src/features/settings/ui/Bad.tsx expect=no-restricted-imports
// 违规：@tauri-apps/* 只能在 platform 里 import
import { invoke } from '@tauri-apps/api/core';
export const run = invoke;
