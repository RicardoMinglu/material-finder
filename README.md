# 资料快搜 · Material Finder

[![Check source](https://github.com/RicardoMinglu/material-finder/actions/workflows/check.yml/badge.svg)](https://github.com/RicardoMinglu/material-finder/actions/workflows/check.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

离线搜索中文 PDF、扫描件、图片和 Word，直接定位原文。

[English](README.en.md) · [快速使用](docs/quickstart.md) · [技术架构](docs/architecture.md) · [已知限制](docs/limitations.md) · [验证记录](docs/VERIFICATION.md)

![资料快搜搜索与原文定位](docs/images/search.png)

资料已经在电脑里，却忘了放在哪份文档、哪一页？选择一个资料文件夹，输入记得的文字或关键词，点击结果即可核对原文。

- **离线处理**：无需账号或模型 API，中英文 OCR 模型随安装包提供。
- **原文定位**：PDF 页内高亮、图片位置高亮，Word 段落或内嵌图片定位。
- **持续更新**：递归读取子文件夹，监听变化；支持暂停、恢复及失败重试。
- **边处理边搜索**：先提取原生文字，再处理 OCR；已完成内容立即可查。
- **保留出处**：复制命中片段、相对路径与页码或段落位置。

## 安装与使用

当前版本为 **1.1.0-rc.1 候选版**。支持 Windows 10/11 x64、macOS Apple Silicon；界面为中文。候选安装包未签名、Mac 未公证，系统可能显示发布者验证提示。先核对发行材料中的 SHA-256 与测试记录。


| 下载 | 适用环境 | 验证状态 |
|---|---|---|
| [Mac 安装包（177 MiB）](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/MaterialFinder-1.1.0-rc.1-mac-arm64.dmg) | Apple Silicon（M 系列） | 本机安装包运行、OCR 和断网测试通过 |
| [Windows 候选包（154 MiB）](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/MaterialFinder-1.1.0-rc.1-win-x64.exe) | Windows 10/11 x64 | 手工安装、升级、断网及高缩放验收待完成 |

[版本说明及校验文件](https://github.com/RicardoMinglu/material-finder/releases/tag/v1.1.0-rc.1) · [29 秒演示视频](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/material-finder-demo.mp4) · [原创演示资料](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/material-finder-demo-fixtures.zip) · [安装与常见问题](docs/faq.md)

普通使用者下载安装包即可，无需下载源码或安装 Node.js。[后续计划与试用反馈](docs/ROADMAP.md)。

1. 安装并打开应用，选择一个资料文件夹。
2. 输入文字片段；多个关键词用空格分隔，例如 `采购 审批`，表示全部关键词都须出现。
3. 点击结果查看原文；可复制片段及出处、打开原文件或在文件夹中显示。
4. 在“资料管理”中查看处理状态、筛选失败文件、暂停/继续及刷新。

**一次维护一个根文件夹。** 选择其他文件夹前会提示替换索引，不会删除原文件。目录暂时不可访问时保留索引。首次扫描件 OCR 可能耗时较长，取决于页数、图像和电脑性能。

支持 PDF、PNG、JPEG、WebP、BMP、TIFF、DOC、DOCX、RTF；按实际文件内容处理伪装为 `.doc` 的 RTF。Word 不提供排版还原或准确页码；旧 DOC 内嵌图片暂不 OCR。加密文档需先解锁。

## 本地开发

需要 Node.js **24.11.1**（24.x）和 npm；应用使用者不需要安装开发工具。

```sh
git clone https://github.com/RicardoMinglu/material-finder.git
cd material-finder
npm ci
npm run assets
npm run typecheck
npm test
npm run dev
```

`assets` 从锁定的 npm 模型包提取 OCR 数据。依赖安装及 Electron 下载需要联网；安装后的应用运行不依赖联网。开发使用的中文示例字体及 OFL 许可证已随仓库提供。

```sh
npm run build
npm run smoke
npm run pack:mac
# Windows 原生环境，或 Mac 交叉打包前：
node scripts/prepare-win-runtime.mjs
npm run pack:win
node scripts/prepare-win-runtime.mjs --verify-packaged release/win-unpacked
npm run checksums
```

Windows 交叉打包不代表通过 Windows 实机验收。详见 [Windows 构建](docs/windows-build.md)。商店打包是独立可选流程，需要自己的公开产品身份和稳定版本号，见 [商店说明](docs/microsoft-store.md)。CI 仅检查和生成构建产物，不自动发布 Release。

## 验证与贡献

```sh
npm run fixtures:quality
npm run validate:quality
npm run fixtures:scale
npm run validate:scale
npm run benchmark:ui
npm run demo
```

这些命令只生成原创资料并使用 `artifacts/` 下的隔离索引。大规模集包含 100 份 PDF、共 1 万页；它是可复现合成测试，不代表所有真实文档。质量集单独验证原生文字、清晰 OCR 与困难样本。完整测量条件和结论见验证记录。

欢迎提供可公开的最小复现样本、解析修复、性能改进和文档贡献。请先阅读 [贡献指南](CONTRIBUTING.md)。不要上传私人资料或完整个人索引。

## 数据与隐私

应用不主动上传资料，不提供遥测、账号、云识别或自动更新。用户主动“复制”会写入系统剪贴板，“打开原文件”会调用系统关联应用。

Mac 数据目录为 `~/Library/Application Support/资料快搜/`；Windows 为 `%APPDATA%/资料快搜/`。商店版使用独立目录。索引和文件快照会占用磁盘；管理页显示占用，不再使用的缓存在索引空闲时清理。数据库格式兼容 1.0.1，升级不要求重新 OCR。

## License

MIT；允许商用与修改，分发时须保留许可。第三方组件、OCR 模型及示例字体各自许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。开源不包含用户导入的文档。
