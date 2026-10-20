# Bun 1.4.3 已收集的运行时材料

本目录随桌面发行物保存为 `licenses/bun-runtime/`。固定 Bun 提交为 `c6da4a4d3010e5553438c60f6bd76d981976867c`，patched WebKit 为 `0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f`。[Bun 固定源码](https://github.com/oven-sh/bun/tree/c6da4a4d3010e5553438c60f6bd76d981976867c)、[WebKit 固定源码](https://github.com/oven-sh/WebKit/tree/0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f)

[index.json](index.json) 记录21项固定 native 源码定义和五份已定位 WebKit/WTF 许可文件的来源、提交、文档路径、字节数与SHA-256，共22组、36份正文/NOTICE。原文件保持原字节；picohttpparser、xxHash 和 libspng 的许可原在源码注释中，保存了完整相应注释，并在索引记录原文件摘要与行范围。第三方原有许可不改成MusicFS的GPL。

This software is based in part on the work of the Independent JPEG Group.

## 尚未完成的材料

索引的 `complete` 为 `false`。这些材料不是完整Bun运行时清单：Bun自身完整MIT正文/署名出处、Rust实际目标依赖正文、WebKit其余逐文件声明和内含ICU等资料、对应源码或对象材料仍有缺口。`Cargo.lock`列出的候选包不等于全部进入成品；源码URL也不等于已经交付源码归档。上游原始说明另见[相邻文件](../bun-1.4.3-LICENSE.md)。实际Bun/JSC源码重建属于可选工程验证，不自行作为MusicFS产品开发或FR16的前置条件；这也不代表现有材料已满足全部发行要求。

## 复用官方构建和运行时替换入口

官方固定版具有本地WebKit构建与Bun重新链接脚本，需要其指定的LLVM与Rust工具链。以下是操作入口，尚未在本项目完成Bun/JSC源码构建验证：[固定构建说明](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/CONTRIBUTING.md)、[固定脚本](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/package.json)。

```sh
git clone https://github.com/oven-sh/bun.git bun-runtime-src
cd bun-runtime-src
git checkout c6da4a4d3010e5553438c60f6bd76d981976867c
bun install --frozen-lockfile
git clone https://github.com/oven-sh/WebKit vendor/WebKit
bun run sync-webkit-source
# 在固定WebKit源码上保存需要重建的修改。
bun run build:release:local
```

在MusicFS对应源码目录，用构建输出的实际Bun路径重新生成应用：

```sh
bun run build:desktop -- --target linux-x64 --runtime /absolute/path/to/rebuilt-bun
```

`--runtime`直接交给Bun官方 `compile.executablePath`，`release.json.runtime`保存实际输入摘要。它只接受一次一个目标；其他系统也须分别指定对应架构的运行时，不能把一个Linux程序传给四目标。替换运行时涉及的源码、修改和许可材料应随对应分发保存，不能由这份固定官方版本资料推断。[官方参数和实现](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/docs/bundler/executables.mdx)

本轮曾用带标记的临时运行时副本验证该替换入口能够组装并运行Linux应用；没有重建JavaScriptCore，不将这次检查扩为常规回归或完整源码重建结论。
