# 发行物第三方资料

本目录只保存构建需要且不来自npm包的固定原始资料；npm依赖的许可在构建时从实际包目录复制。

- `bun-1.4.3-LICENSE.md`：原始来源为 <https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.3/LICENSE.md>，SHA-256 `056696884250b0d682365260cf1487a6501b1665a343ec60e23a1e647043c572`。仅桌面编译产物包含Bun运行时，Worker不复制它。该文件包含运行时和嵌入库的说明及来源链接，**不是全部嵌入库许可正文的集合**；运行时许可资料仍需收口，不能据此标记全部许可验收完成。
- 发行物 `licenses/core/index.json` 与对应文件来自Bun构建清单中的npm依赖，保留原许可及包内NOTICE等资料；不复制没有参与构建的整个依赖安装目录。
- `licenses/WebUI.md`由锁定的Vite内建`build.license`生成，包含已打包页面依赖的许可资料。机制说明：<https://vite.dev/config/build-options#build-license>。
- QQ、网易云与最小来源的许可随各自插件ZIP保存。桌面随包rclone的原始README包含其MIT正文及版本资料，位于资源目录的`RCLONE-README.txt`；实际文件摘要另见`rclone-release.json`。

MusicFS自行编写代码的许可与各第三方许可分别适用；不从示例插件的许可推断所有文件采用同一许可。
