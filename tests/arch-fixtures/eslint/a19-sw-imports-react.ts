// arch-fixture: path=src/sw/bad.ts expect=no-restricted-imports message=A19 rule=A19
// 违规：sw 只能 import shared 和 workbox-*
import { useState } from 'react';
export const x = useState;
