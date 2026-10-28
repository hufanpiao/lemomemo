// arch-fixture: path=src/platform/bad.ts expect=no-restricted-imports
// 违规：platform 不准 import React
import { useState } from 'react';
export const x = useState;
