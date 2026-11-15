# 可选 Microsoft Store 打包

公开工程不携带发布者身份、证书或账号。普通 EXE/DMG 构建不需要 Store 配置。

1. 将 `build/store-identity.example.json` 复制为被 Git 忽略的 `build/store-identity.json`，用自己的 Partner Center 公开产品身份替换占位值。不要放入账号密码或证书。
2. 商店只接受稳定的 major.minor.patch；当前 rc 版本按设计拒绝商店出包。正式商店版本需要另行准备稳定版本号。
3. 运行 `npm run store:check` 检查身份语法及版本。它不验证线上账号关联。
4. 使用 `npm run pack:store`；Windows 使用系统 MakeAppx，Mac 使用固定版本微软 MSIX SDK。此流程仅生成未签名 AppX，不上传或提交认证。
5. Windows 原生安装、升级、断网 OCR、WACK 和官网版共存需单独验收。商店数据保存在独立的“资料快搜 Store”目录。

可使用 MATERIAL_FINDER_STORE_IDENTITY_NAME、MATERIAL_FINDER_STORE_PUBLISHER、MATERIAL_FINDER_STORE_PUBLISHER_DISPLAY_NAME 三个环境变量整体覆盖身份；不得混用不同产品的字段。
