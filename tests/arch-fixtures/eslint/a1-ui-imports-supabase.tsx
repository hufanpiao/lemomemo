// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=boundaries/dependencies rule=A1
// 违规：功能的 ui 不准直接 import platform/supabase（原 A16）
import { getSupabase } from '../../../platform/supabase/client.ts';
export const s = getSupabase;
