# 安装与常见问题 / Installation FAQ

## 下载哪个文件？ / Which download?

从 [预发布页](https://github.com/RicardoMinglu/material-finder/releases/tag/v1.1.0-rc.1) 的 Assets 下载：Mac M 系列芯片选 `mac-arm64.dmg`，Windows 10/11 x64 选 `win-x64.exe`。`Source code` 是开发源码，不是可直接安装的应用。暂不提供 Intel Mac、Windows ARM 或 Linux 安装包。

Choose `mac-arm64.dmg` for Apple Silicon or `win-x64.exe` for Windows x64. The automatic “Source code” archives are for developers. Intel Mac, Windows ARM and Linux are not supported targets for this release.

## 如何校验？ / Verify a download

下载同一版本的 `SHA256SUMS.txt`。Mac 使用 `shasum -a 256 文件名`，Windows PowerShell 使用 `Get-FileHash 文件名 -Algorithm SHA256`，将结果与清单对应行比较。`shasum -a 256 -c SHA256SUMS.txt` 适用于下载了清单中全部文件的目录。

Download `SHA256SUMS.txt` from the same release and compare the matching entry with `shasum -a 256 filename` (macOS) or `Get-FileHash filename -Algorithm SHA256` (PowerShell).

## Mac 提示无法验证开发者 / macOS developer warning

候选包未签名、未公证。把应用从 DMG 拖入“应用程序”。首次打开若被系统阻止，先确认来源和校验值，再进入“系统设置 → 隐私与安全性”，按该应用对应的“仍要打开”流程处理。受组织管理的电脑可能需要管理员许可。不需要关闭全局 Gatekeeper。若提示文件损坏，先重新下载并校验，将错误原文附到问题反馈。

The candidate is unsigned and not notarized. Move it from the DMG into Applications. If macOS blocks it, verify the download before using the app-specific “Open Anyway” option in System Settings → Privacy & Security. Managed devices may require administrator approval. Do not disable Gatekeeper globally.

## Windows 提示未知发布者 / Windows publisher warning

安装包未签名，可能显示 SmartScreen 或未知发布者提示。先核验 GitHub 下载地址与 SHA-256，再根据系统提供的“更多信息”及运行选项操作；组织策略阻止时联系管理员。Windows 手工安装、升级和高缩放尚待验收，请将问题与系统版本一并反馈。

The installer is unsigned and may trigger SmartScreen or an unknown-publisher warning. Verify its source and checksum before using the options offered by Windows. Manual Windows acceptance remains pending.

## 找不到资料或搜索很慢 / Missing results or slow indexing

先看“资料管理”：文字提取先完成，扫描件与图片随后 OCR；暂停、未处理或失败的内容可能尚不可搜索。空格表示多个关键词全部匹配，可先用较长、明确的词。首次 OCR 耗时取决于资料页数与质量；已处理内容可立即查询。模糊、手写、公式和明显变形扫描件不保证识别。暂时断开外接硬盘后应恢复原路径，再刷新。

Check processing status first. Native text becomes searchable before OCR finishes. Space-separated keywords use AND. Completed content can be searched while indexing continues; difficult scans and handwriting may not be recognized.

## 数据和升级 / Data and upgrades

应用无需账号，不上传文档。索引和快照保存在 Mac 的 `~/Library/Application Support/资料快搜/` 或 Windows 的 `%APPDATA%/资料快搜/`，商店版另行隔离。升级保留 1.0.1 数据结构；实际旧安装环境的完整升级仍需验证。升级前可退出应用并备份整个数据目录，勿只复制正在写入的 SQLite 文件。切换根目录会替换索引，不删除原资料。

The application needs no account and does not upload documents. It preserves the 1.0.1 database schema. To back up, quit the app and copy its entire data directory. Switching the root replaces the index, not the originals. End-to-end upgrade testing on an existing installation remains pending.

## 如何反馈 / Feedback

使用 [问题反馈](https://github.com/RicardoMinglu/material-finder/issues/new?template=bug.yml) 或 [功能建议](https://github.com/RicardoMinglu/material-finder/issues/new?template=feature.yml)。请附应用版本、系统版本、步骤及可公开的最小样本；不要上传私人资料或完整索引。See the same issue forms for bugs and feature requests; include a public minimal reproduction only.
