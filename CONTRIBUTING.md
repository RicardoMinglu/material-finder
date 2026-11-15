# Contributing / 参与贡献

Use Node.js 24.11.1. Run `npm ci`, `npm run assets`, `npm run typecheck`, `npm test` and `npm run build`. Desktop changes also require `npm run smoke`. Reports and screenshots belong in ignored `artifacts/` and `output/` directories.

请先用小范围改动说明问题、预期行为和验证结果。解析问题请提供原创或有权公开的最小样本；不要提交私人文档、索引、缓存、证书、密钥或个人路径。

检索改动须保持短词、AND、原文偏移、高亮和分页排序语义，并通过独立参考算法对照测试。原生文字与 OCR 质量分开测量。性能报告必须说明硬件、数据量、冷热状态及计时边界。

The main process must remain responsive. Keep SQL and ranking inside the query process, writes inside the index process, and restrict renderer capabilities through validated IPC. Do not add network requests or telemetry without a separately reviewed product decision.

MIT applies to contributions. Preserve third-party notices and public fixture licenses. Installer generation is not publication and is not proof of runtime validation on another operating system.
