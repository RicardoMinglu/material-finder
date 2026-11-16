# 后续计划与试用反馈 / Roadmap and pilot feedback

首版优先验证“记得一段文字，找回它所在的文件和位置”。以下是待办，不是已经完成的能力或发布日期承诺。

The first release focuses on finding a remembered passage and its original location. These are pending tasks, not completed features or release-date commitments.

## 进入稳定版前 / Before a stable release

- [ ] Windows 10/11 x64 手工安装、启动、卸载。
- [ ] 实际 1.0.1 安装环境升级，保留索引和已完成 OCR。
- [ ] Windows 断网导入、OCR、检索和预览。
- [ ] Windows 100% / 150% / 200% 缩放及小窗口操作。
- [ ] 真实混合资料库、外接硬盘、长时间运行与恢复验证。
- [ ] 至少 5 位目标使用者试用；根据反馈优先修复安装、定位与 OCR 问题。

CI 的源码检查、安装包自动化测试与上述手工验收分别记录；不能相互替代。签名、公证与商店发行需要后续配置和投入。

Record source CI, packaged desktop automation and manual acceptance separately. Signing, notarization and store distribution require additional setup.

## 试用时反馈什么？ / What to report during a pilot

1. 系统和应用版本，是否顺利安装。 / OS, app version and installation outcome.
2. 资料大致数量、格式，首次处理是否能理解。 / Library size, formats and indexing experience.
3. 尝试了什么查找任务，是否定位到正确原文。 / Search task and whether the original location was correct.
4. 卡住、错误或不清楚的操作。 / Errors, delays or confusing controls.
5. 是否愿意继续使用，最希望优先改进的一点。 / Whether you would keep using it and your top improvement.

通过 [Issue](https://github.com/RicardoMinglu/material-finder/issues) 提交脱敏反馈。若至少 3/5 位愿意继续使用，优先投入 OCR、性能与安装体验；否则先重新验证具体使用场景。这是产品判断参考，不能代替更广泛的用户研究。

## 当前范围 / Current scope

保持单资料夹、离线关键词搜索、原文定位。多资料库、语义搜索、AI 问答、云同步、CLI/MCP 和移动端暂不纳入本版。可通过功能建议描述真实任务和现有替代方法，帮助后续判断。

Single-folder offline keyword search and source navigation remain the scope. Multiple libraries, semantic search, AI chat, cloud sync, CLI/MCP and mobile apps are outside this release.
