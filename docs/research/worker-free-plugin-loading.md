# Worker 免费计划下的插件机制候选

日期：2026-10-18。问题：满足 WebUI 安装、更新、移除插件，避免以付费 Dynamic Workers 为必要前提。

2026-10-20 决定更新：用户已接受安装、更新和移除插件时由后台自动发布新 Worker 版本，A 路线作为 P0 首选。此更新记录产品决定，不补充任何技术通过证据，见 [ADR 0002](../adr/0002-worker-plugin-installation-by-deployment.md)。

2026-10-20 依赖证据补充：[新增依赖核查](architecture-dependencies.md#5-worker-自动部署官方-sdk-处理-api-机制)已读取 Cloudflare 官方 SDK，确认其 Bun/Workers 运行时声明及普通 Scripts 版本上传/部署入口，优先复用 SDK。下文原联网失败属于 2026-10-18 调查记录；普通免费额度、完整自部署、绑定保留和结果核对仍无本项目实测。

## 证据状态

上一轮已读取 Cloudflare 官方 Dynamic Workers API 与定价文档，确认运行时加载代码及 Paid plan 前提。本轮 web 与搜索连接器连接失败，普通 shell 无法联网，提升后的公共文档读取长期无结果，已中止等待。下面免费路线是工程候选，相关标准 Worker 上传接口、当前套餐限制和端到端流程尚未完成本轮核查；没有部署、编译或运行验证。待复核链接只表示资料入口，不表示本轮已读取。

已核查来源：[Dynamic Workers API](https://developers.cloudflare.com/dynamic-workers/api-reference/)、[Dynamic Workers 定价](https://developers.cloudflare.com/dynamic-workers/pricing/)。

## 需求不要求运行中热加载

用户已经确认的是普通使用者不必自行重新编译 MusicFS，可以在 WebUI 安装作者提供的预构建插件包；没有要求后台永不重新部署。插件作者构建、后台组装部署模块、用户手工构建，是三个不同的动作。

因此可以优先调查自动部署普通 Worker 的方案，而不先把付费动态执行当作产品前提。插件机制的领域合同仍是已确认的目录、文件、配置和认证接口；具体代码如何进入 Worker 属于宿主实现。

## A：预构建模块 + WebUI 自动部署（优先 PoC）

候选流程：

1. MusicFS 发布预构建的 Worker 核心；插件作者发布依照插件合同构建的 JavaScript 模块与清单。
2. 用户在 WebUI 上传插件包或填写发布地址；应用核对接口版本、目标宿主与依赖。
3. 后台生成静态插件注册模块，将核心与所需插件模块组装成标准 Worker 部署内容，通过部署 API 发布新版。
4. 管理界面查询新版状态；账号、实例配置与布局仍保存在独立持久层。

这里不要求安装时在线安装 npm 包或执行任意 TypeScript 构建。插件开发工具需要提前处理依赖与资源，并约定宿主 API 的导入方式；能否直接上传独立 ESM 模块而无需额外打包，由 PoC 确认。

这条路线的目标是复用标准 Worker 部署与执行，避免运行时动态加载产品的付费前提；它是否能容纳本项目的代码体积、CPU 和实际请求量仍待验证。不能等同于无限制免费运行。

预计部署时需要配置有更新目标 Worker 权限的 Cloudflare API token。安装、更新和移除会触发版本切换，需要验证状态保留、失败恢复、正在播放的读取及安装请求自身的生命周期。不要假定在同一个 Worker 请求里更新自己后仍能可靠完成所有后续步骤，也不要在 PoC 前承诺无中断。

待复核官方入口：[Workers API](https://developers.cloudflare.com/api/resources/workers/)、[multipart 上传元数据](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)、[版本与部署](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)、[平台限制](https://developers.cloudflare.com/workers/platform/limits/)。具体上传字段和绑定保留规则本轮未确认。

## B：每个插件独立部署为普通 Worker

候选流程是主程序管理实例和目录，每个插件有独立的普通 Worker 部署，通过 Service Binding 或认证的 HTTP 接口调用。安装更新由 WebUI 驱动部署插件 Worker，主程序不必把所有插件代码收进同一个模块集合。

这是普通账号下多个 Worker 的设计候选，不默认使用 Workers for Platforms。与 A 相比，它需要更多部署管理、调用鉴权、宿主 API 代理和流转发；服务绑定变化是否需要同时部署主程序、同账号 Worker 调用限制、免费资源数量和计量方式都需核查。

只有 A 的模块体积或更新耦合成为实际障碍时，再评估这些成本是否值得。它并不天然保证调用更便宜或音频流更可靠。

待复核入口：[Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)、[平台限制](https://developers.cloudflare.com/workers/platform/limits/)。

## C：静态内嵌解释器，解释后安装的插件文本

候选机制是在发行 Worker 时放入 QuickJS/WASM 或纯 JavaScript 解释器；安装插件只保存 JavaScript 文本，运行时由解释器执行，而不是让宿主直接对下载的文本调用 eval。

这在设计上与 V8 动态代码执行、运行时编译新 WASM 模块不同，但具体解释器产物、加载胶水、Worker 兼容和免费计划是否可用尚未核实。不能据此直接承诺普通 Worker 支持任意 JavaScript 插件。

解释器还需要接入 fetch、密码学、异步任务、二进制数据与音频流等宿主能力；现有平台依赖不能假定原样可运行。CPU、内存、包体、流桥接与取消语义均需实测。除非“安装时绝不重新部署”成为硬性要求，否则不作为当前首选。

待复核入口：[Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)、[Web 标准限制](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)、[QuickJS Emscripten 上游](https://github.com/justjake/quickjs-emscripten)。

## D：声明式 HTTP 数据源插件

由核心预置执行器，插件包只描述请求、字段映射和流程。简单 HTTP 音频目录可能适合这一模型；复杂认证、签名、分页和刷新协议则可能迫使描述语言不断扩张。

它可以作为一种插件实现方式，但目前没有证据证明能以更低成本承载网易云和 QQ 的全部现有要求。不应为避免付费而把已经确认的可编程数据源插件悄悄缩成有限配置模板。

## 优先验证项

建议先验证 A，暂不接受付费 Dynamic Workers 为必需条件。以下是技术验证责任，不逐项变为产品问题：

- 在普通免费账号中，通过实际允许的 API 上传预构建模块并激活新版；核对所需 token 权限与部署限制。
- 复用核心和 WebUI 静态产物，确认安装插件不要求重新构建前端。
- 保留 Secrets、D1、静态资源及其他绑定，不因更新意外更换数据位置或丢失配置。
- 协调代码版本、插件清单和实例状态，确认失败保留可用版本，过期任务不写回新状态。
- 验证更新期间 HEAD、Range、长音频流、取消和管理页面重连，记录真实影响。
- 测量核心及示例插件的部署体积、CPU、请求和存储消耗，核对当时的免费限额；不预填未经核查的数值。
- 完成新增无账号/无音质的最小插件、多个实例、移除与重装恢复，证明插件机制不是两平台的固定分支。

2026-10-20 已完成产品对齐：允许安装、更新、移除时由后台自动发布普通 Worker 新版本。允许版本切换不等于接受任何中断时长；实际影响由 PoC 测量后说明。
