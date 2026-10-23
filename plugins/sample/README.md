# 最小音频来源

[English](README.en.md)

这个插件提供一份确定的 `440 Hz.wav`：1 秒、8 kHz、16 bit、单声道，共 16,044 字节。它没有账号、认证、歌单或音质模型，用于展示普通文件来源也能通过公开合同接入 MusicFS。

从独立目录开始修改、构建和安装，见[插件作者指南](../../docs/plugin-authoring.md)。作者包尚未依赖公开 npm 发布的 SDK：`@musicfs/plugin-api` 由随包的 `packages/plugin-api/` 提供。

在独立作者包根目录运行：

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
```

在完整 MusicFS 仓库根目录，示例的构建命令是 `bun run build:sample`。输出统一为 `dist/plugins/<manifest.id>.zip`；派生新插件时先修改 manifest 的 ID、名称和版本，再交给已有 WebUI 检查兼容性和安装，不需要重新编译核心或页面。

| 文件 | 用途 |
|---|---|
| [index.ts](index.ts) | 默认导出 `SourcePlugin`，仅从公开 API 导入类型；入口名称来自当前实例配置 |
| [config.schema.json](config.schema.json) | 必填的 `label` 配置，以“目录名称”显示在通用表单 |
| [translations.json](translations.json) | 可选显示词典，不改变配置值或导出文件名 |
| [manifest.json](manifest.json) | 稳定插件 ID、发布版本、宿主入口、结构版本和需要封装的文件 |
| [generated-config.d.mts](generated-config.d.mts) | Ajv 生成验证器的类型声明；`.mjs` 在构建时生成 |
| [LICENSE.txt](LICENSE.txt) | 当前示例自有代码的 GPL-3.0-only 许可 |

`roots` 返回一个入口，`list` 返回一份带完整 `info` 的文件描述，`stat` 返回相同描述。`open` 核对内容身份和闭区间范围，以小块原生流交付实际字节，并检查取消信号。音频字节是与实例无关的确定常量；实例配置直接从 `ctx.config` 读取，不存到模块变量。

配置中的“目录名称”改变入口的名称，不改变 WAV 内容身份。创建两个实例并分别设置不同名称，可以验证同插件的独立配置；保存后的目录布局别名仍由用户控制。后续添加网络来源、私有状态或迁移时，遵循[公开合同](../../docs/architecture/plugin-interface.md)，不依赖核心内部模块。
