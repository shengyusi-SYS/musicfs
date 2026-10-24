# Worker 插件变更允许后台自动部署

2026-10-20，用户确认 Worker 安装、更新和移除插件时，可以由后台自动发布新版本；使用者通过 WebUI 操作，无需自己编译或执行部署命令。优先验证将预构建的核心与插件模块组装为普通 Worker 部署内容的路线，避免把付费 Dynamic Workers 作为插件机制的必需前提。

选择自动部署而非要求运行中热加载，是因为当前需求允许版本切换，可以先复用原生 JavaScript 模块执行，减少解释器适配或多 Worker 调用管理。插件业务接口与领域职责不依赖这项宿主选择；免费计划兼容、部署凭据权限、Secrets/D1/静态资源绑定保留、失败恢复与正在读取的音频均须 P0 验证，不承诺无限免费或无中断。

依据：[用户决定](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/planning/requirements-decisions.md)、[候选与证据边界](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/research/worker-free-plugin-loading.md)。
