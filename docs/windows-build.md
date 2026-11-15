# Windows x64 构建与验收

在 Windows 10/11 x64、Node.js 24.11.1 环境执行：

```powershell
npm ci
npm run assets
node scripts/prepare-win-runtime.mjs
npm run typecheck
npm test
npm run pack:win
node scripts/prepare-win-runtime.mjs --verify-packaged release/win-unpacked
$env:MATERIAL_FINDER_EXECUTABLE = (Resolve-Path './release/win-unpacked/资料快搜.exe').Path
npm run smoke
```

Mac 也可交叉生成 EXE，但不能替代 Windows 使用验收。分别验证应用与 PDF.js 依赖的 Canvas 精确版本，禁止混用原生二进制。必要时可显式配置可信 Electron 下载镜像；它只影响构建。

原生验收：普通用户安装；中文及含空格路径；断网导入与 OCR；搜索、复制出处、原文预览；暂停退出恢复；1.0.1 数据升级；查询/索引异常恢复；100%、150%、200% 显示缩放；卸载行为。记录系统版本、版本号、包 SHA-256 和每项结果。

候选 EXE 未签名。不把“资源检查通过”写成“Windows 实机测试通过”。
