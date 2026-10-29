// 违规 F2（代码审查有条件通过 4）：经 .jsx、.cjs、.cts、.mjs、.mts 文件间接引到 _shared/db.ts，每个文件都要跟得到
import './a.jsx';
import './b.cjs';
import './c.cts';
import './d.mjs';
import './e.mts';
