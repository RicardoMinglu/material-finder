# 1.1.0-rc.1 验证记录

日期：2026-11-15（北京时间）。本机：Apple M4、16 GB、macOS ARM64；开发 Node.js 24.11.1，应用 Electron 45.0.0。

## 已执行

- TypeScript 类型检查通过；46 项单元及集成测试通过。
- 1.0.1 冻结表结构创建的隔离数据库副本：源文件 ID、内容单元 ID、暂停状态和表结构保留，无 OCR 重建。
- 独立穷举参考算法与新排序对照；跨连接写入后的查询缓存失效；分页、短词、字形归一化、UTF-16 高亮与来源数验证。
- 查询队列、缓存边界、符号链接保护、清理后重新加入同内容文件等回归测试。
- Electron 界面：PDF/Word/图片、OCR、高亮、后台处理期间保持阅读页、复制出处、切换目录取消/确认、800×600 布局及查询/索引进程被终止后恢复。

## 质量集（全新索引，外部网络被系统阻止）

原创资料使用仓库附带的 Noto Sans CJK SC 字体。共 40 个文件、123 个内容单元，预先定义 108 条查询及预期来源。

| 组别 | 前五条命中正确来源/位置 | 结果 |
|---|---:|---|
| 原生文字 | 60/60 | 通过 |
| 清晰印刷体 OCR | 46/46 | 通过 ≥90% 门槛 |
| 困难样本 | 1/2 | 单独记录；明显拉伸扫描件未命中 |

全新索引约 18.79 秒，其中文字提取约 3.05 秒、OCR 阶段约 15.74 秒；测试进程峰值 RSS 约 944 MiB。该结果是固定样本的检索成功率，不是 OCR 字符准确率，也不代表所有中文资料。困难样本仅两个，不能据此估计整体困难文档效果。

原始结果：[quality.json](reports/quality.json)。复现：`npm run fixtures:quality`，再执行 `npm run validate:quality -- --fresh`。

## 1 万页规模集

100 份真正经过 PDF 提取流程的合成中文 PDF，每份 100 页。无直接预填数据库，规模集为原生文字；扫描件质量单独评估。

- 首次索引约 83.40 秒；100 份全部完成，错误 0、待处理 0。
- 索引测试进程峰值 RSS 约 540 MiB；当时 profile 含索引、WAL、缓存约 158.4 MiB。
- 独立核心查询 120 次，P95 约 204.13 ms。
- 应用界面预热后 120 次查询：P50/P95/最大值见 ui-performance.json；**P95 199.40 ms，最大 247.00 ms**，通过 500 ms 目标。
- 界面计时从 IPC 提交开始，到结果 DOM 提交后的动画帧；不含 180 ms 输入防抖及 PDF 首次绘制。与核心查询的输入序列不同，不能直接相减。

这是固定合成资料上的测试，不是任意 1 万页资料或低配置电脑的保证。应用各进程内存采样见报告；峰值 RSS 不等于整个系统或全部进程的峰值。

原始结果：[scale.json](reports/scale.json)、[ui-performance.json](reports/ui-performance.json)。复现：`npm run fixtures:scale`、`npm run validate:scale -- --fresh`、`npm run benchmark:ui`。

## 断网边界

中文质量测试在 macOS `sandbox-exec` 的 `deny network-outbound` 策略下完成。桌面自动化仅放行本机 loopback，用于测试控制，外部 HTTPS 探针被阻止。

桌面测试中的外层系统 sandbox 与 Chromium 嵌套 sandbox 不兼容，因此仅此测试启动附加 `--no-sandbox`；外层网络限制仍生效。发行应用保持 renderer sandbox 开启，正常打包应用另行测试。没有通过断开系统网络或更改全局防火墙影响其他应用。

复现：`npm run smoke:offline`（macOS）。该自动化不是 Windows 断网验证。

## 平台与尚待验证

Mac 开发应用、打包应用及最终 DMG 经只读挂载后复制出的应用均通过桌面测试；DMG 提取版也通过系统限制外网的 OCR、检索和预览测试。见 [macos-installed.json](reports/macos-installed.json)、[macos-offline.json](reports/macos-offline.json)。

从 Git 暂存源码导出全新目录，执行 `npm ci`、OCR 资源提取、类型检查、46 项测试与构建，全部通过。所有生成的 dist 文件与候选包对应构建逐字节一致。本项跳过 Electron 二进制下载；安装包实际运行验证另行完成。见 [clean-build.json](reports/clean-build.json)。

Windows x64 安装包在 Mac 交叉生成，核对 PE 架构、Canvas、OCR/PDF 资源和校验值。尚未在 Windows 实机执行：安装/升级、断网运行、100%/150%/200% 缩放、卸载；不得将交叉构建写成 Windows 实机通过。

候选版本未签名、未公证，未运行远程 GitHub CI，未公开仓库、Release、官网或商店。真实用户试用和持续数日运行仍是后续验证。
