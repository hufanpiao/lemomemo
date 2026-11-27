// 违规 F6：预览专用函数的顶层入口进了仓库（只许 deploy-preview.yml 在产物里生成），正式发布会把它带上去
import '../_preview/r2-probe/index.ts';
