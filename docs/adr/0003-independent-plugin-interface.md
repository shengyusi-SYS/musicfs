# 插件合同独立于核心和第三方对象

MusicFS 将插件作者所需的类型与数据合同独立提供，示例插件和第三方仅依赖这一 Interface；不跨 seam 传递核心内部对象、React 组件、Zod/Ajv 实例、DAV Resource 或数据库句柄。配置使用可序列化 JSON Schema 与有限 UI 提示，音频读取使用标准字节与 Web Stream 合同，使插件更新、前端复用和双宿主 Adapter 能分别演进。

代价是需要明确包、状态与错误合同，并验证 Schema/生成校验的一致性；收益是来源规则不会随某个 UI、DAV 或存储库的实现进入核心。JSON Schema 的后端结构校验优先由作者构建时用 Ajv 生成，避免在 Worker 运行时编译代码；公开签名和包格式仍需 P0 最小插件验证后收敛。详见 [架构](../architecture/README.md)、[插件合同草案](../architecture/plugin-interface.md) 和 [依赖证据](../dependencies.md)。
