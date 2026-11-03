# 香港天文台《公历与农历日期对照表》原始文件

- **来源**：香港天文台（Hong Kong Observatory）公开历表，文本版
- **地址**：https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T{年份}c.txt
- **范围**：T1901c.txt～T2100c.txt，共 200 个文件，合计 5,709,394 字节
- **下载**：2026-11-03，主持人用 curl 逐个下载，HTTP 200；格式为 UTF-8 带 BOM、CRLF 换行，内容是繁体中文的公历、农历、星期、节气对照
- **校验**：同目录 `SHA256SUMS`（`sha256sum -c SHA256SUMS` 可复核）；`.gitattributes` 让这些文件按字节原样入库
- **使用条件**：负责人 11-03 定（R-299、R-306、R-309）：按香港天文台网站条款的非商业用途使用，在本文件和 App 的“关于”页注明出处“农历及节气数据：香港天文台”
- **用途**：由 `tools/lunar/adapters/` 下的适配器转成 `tools/lunar/sources/cn-months.json`、`cn-terms.json`，再由 `tools/lunar/build.mjs` 生成 `shared/logic/anniv/lunar-data.ts`。App 运行时不读这些原始文件
