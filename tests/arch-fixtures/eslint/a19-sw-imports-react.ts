// arch-fixture: path=src/sw/bad.ts expect=no-restricted-imports
// 违规：sw 只能 import shared 和 workbox-*
import { useState } from 'react';
export const x = useState;
