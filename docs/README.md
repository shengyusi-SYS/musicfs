# MusicFS 文档

[English](en/README.md)

## 使用 MusicFS

[下载与升级](release.md) → [添加音乐来源](user-guide.md) → [连接播放器](clients.md)

- [桌面、托盘、自启与挂载](desktop.md)
- [NAS、SSH 与无桌面运行](headless.md)
- [Cloudflare Worker 部署与升级](worker.md)
- [兼容性与已验证范围](verification.md)

## 开发插件

[作者指南](plugin-authoring.md) → [公开接口](architecture/plugin-interface.md) → [类型定义](../packages/plugin-api/src/index.ts)

示例插件在 `plugins/`，可选音频标签工具在 `packages/audio-tags/`。

## 开发主程序

[开发与发行](development.md) → [架构](architecture/README.md) → [管理 API](management-api.md)

| 内容 | 入口 |
|---|---|
| 产品范围与名词 | [需求](requirements.md)、[术语表](glossary.md) |
| 模块、状态所有权和时序 | [架构索引](architecture/README.md)、[图表](architecture/diagrams.md) |
| 第三方依赖的用途和取舍 | [依赖说明](dependencies.md) |
| 离线回归和专项诊断 | [验证参考](development-reference.md) |
| 重要设计决定 | [ADR](adr/) |
| 可复用的工程结论 | [工程经验](engineering-lessons.md)、[交互与访问](lessons/interface-and-access.md) |

文档按职责组织：`architecture/` 保存现行设计，`adr/` 保存关键决定，`research/` 保存仍有参考价值的专项依据，`lessons/` 保存长期经验。英文指南位于 `en/`。早期计划、原始测试回执和开发截图从 Git 历史追溯。
