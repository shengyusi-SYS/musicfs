# 插件架构新增通用依赖核查

日期：2026-10-20  
范围：声明式配置表单、插件包解析、版本兼容、Worker 自动部署、模块依赖检查。仅核查官方文档与维护方源码；没有安装依赖、运行 PoC、读取部署凭据或部署 Worker。现有 Hono、React、Vite、Ant Design、TanStack Query、Zod、p-limit 的选择沿用既有调查。

依据：[统一需求与技术方案](../requirements.md)、[精简与依赖替代](dependency-selection.md)。下文“建议”属于本项目设计判断；文档或源码存在某接口，不代表已在本项目两个宿主验证通过。上游 main 和在线文档是浮动证据，接入时须核对实际发布版本、peerDependencies、锁文件与构建结果。

## 1 建议结论

| 通用能力 | 优先候选 | 接管的机制 | 本项目继续负责 |
|---|---|---|---|
| 插件配置表单 | `@rjsf/antd`、`@rjsf/core`、`@rjsf/validator-ajv8` | JSON Schema 到表单、字段状态及通用结构校验 | 实例草稿与保存、认证步骤、来源语义与兼容的声明范围 |
| Worker 中的插件配置校验 | 官方工具链/示例优先 Ajv standalone 生成 ESM；经插件合同调用 | Schema 编译及执行，不在 Worker 动态生成代码 | 与同一公开 Schema 一致、来源的异步语义校验、统一错误结果；第三方可自选内部校验库 |
| 插件 ZIP 解析 | `zip.js` 与 `fflate` 同批 PoC，比较 Worker 适配、CPU/内存和安装器剩余代码 | ZIP/DEFLATE 解码及库已有的归档检查 | 包结构、模块清单、实际解压预算与安装/切换状态；补足所选库未覆盖的路径边界 |
| 插件版本范围 | npm `semver` | 合法版本、范围匹配、预发行语义 | 插件合同版本、宿主能力、迁移及能否实际激活 |
| Worker 部署 | Cloudflare 官方 `cloudflare` TypeScript SDK | API 类型、上传编码、错误类型、超时和底层重试 | 模块组装、发布计划、状态确认、绑定/资源保留和恢复 |
| 源码边界检查 | `dependency-cruiser`，仅开发依赖 | 导入图、循环、跨层及间接越界检测 | 允许的依赖方向、动态插件的合同与打包检查 |

按对应实现步骤增量加入，不在工程初始化一次安装全部候选。依赖数量少不是目标，减少通用机制的自有代码才是目标。

## 2 配置协议与表单

### 2.1 优先 RJSF 的 Ant Design 主题

RJSF 能根据 JSON Schema 生成 React 表单，并提供 `uiSchema` 定制；其官方主题清单包含 `@rjsf/antd`。因此，现有 React + Ant Design 基线上优先验证这一组合，避免自行从字段类型开始造表单引擎。[RJSF 介绍](https://rjsf-team.github.io/react-jsonschema-form/docs/)、[主题清单](https://rjsf-team.github.io/react-jsonschema-form/docs/usage/themes/)

JSON Forms 有清晰的 Schema、UI Schema 和 renderer 分工，但官方 React renderer 清单是 Material 与 Vanilla；没有在该官方清单中找到 Ant Design renderer。以本项目基线，采用它将新增一套组件体系或 renderer 维护责任，当前不优先。[JSON Forms renderer sets](https://jsonforms.io/docs/renderer-sets/)、[自定义 renderer](https://jsonforms.io/docs/tutorial/custom-renderers)

公开合同应传递可序列化的 JSON Schema 和有限的 UI 提示，不传 Zod schema 实例、Ajv 实例、React 组件或 JavaScript 回调。核心内部 DTO 可继续使用 Zod；来源配置 Schema 属于插件声明。首轮建议选定 JSON Schema draft-07 及可支持的标准关键字，避免每个插件自行选择方言。

建议插件提供 JSON 数据形式的字段排序、密码/多行等 widget 名称，核心映射到受支持的组件；若采用 RJSF `uiSchema`，合同明确只接受其中可序列化且已支持的子集。RJSF 的全部扩展能力不自动成为插件公共 API。[RJSF uiSchema](https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema/)

认证仍是单独的领域流程：表单库呈现输入，Ant Design 呈现二维码、链接、按钮及反馈；插件提供步骤和状态，实例管理负责操作身份、取消和条件写入。不能把扫码轮询、验证码过期或凭据保存交给表单库，也不需要为此先引入通用工作流引擎。

### 2.2 Worker 不能直接沿用 Ajv 动态编译

RJSF 的 `@rjsf/validator-ajv8` 是 Ajv 8 验证器；Cloudflare Workers 禁止 `eval` 和 `new Function`。因此“后端收到新 Schema 后调用 Ajv compile”不能直接作为双宿主方案。[RJSF 校验](https://rjsf-team.github.io/react-jsonschema-form/docs/usage/validation/)、[Worker JavaScript 限制](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)

官方工具链与示例插件优先验证构建时的 Ajv standalone：同一个 Schema 生成 ESM 验证函数，随预构建插件发布。Worker 安装已允许组装模块并部署，静态加载验证函数契合该路线。Ajv 官方支持生成 ESM，但生成代码仍可能依赖 Ajv runtime，作者构建需一起打包。[Ajv standalone](https://ajv.js.org/standalone.html)

公共合同只要求声明约定方言的 JSON Schema、返回与它一致的校验结果，并符合所声明宿主的运行限制；不强制第三方插件使用 Ajv。作者可自选 Zod、Valibot 或其他内部工具，但须自行保证序列化 Schema 与校验逻辑一致，且 Worker 运行时不动态生成代码。

核心可以经插件合同调用 `validateConfig` 一类操作，取得 JSON 可序列化的字段错误；此处名称是接口设计建议，不是已冻结签名。通用结构校验来自生成器，服务器地址可达性、音质能力、配置是否适用于当前登录实例等语义校验仍由插件完成；后端保存以插件返回的完整结果为准，前端表单校验不能代替它。

若后续确有运行时生成未知 Schema 的必要，候选是无代码生成的 `@cfworker/json-schema`。RJSF 已提供官方 `@rjsf/validator-cfworker` 适配，但其 README 明确列出底层的 `additionalProperties` 等正确性报告及不支持的扩展，不能写成成熟且完全等价的 Ajv 替代。[cfworker 说明](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)、[RJSF cfworker README](https://github.com/rjsf-team/react-jsonschema-form/blob/main/packages/validator-cfworker/README.md)

### 2.3 接入验证点

- 核查实际发布的 `@rjsf/*` 版本一致性及 React、Ant Design、icons 等 peerDependencies；上游源码当前的版本与依赖范围不替代 npm 发布包核验。[Ant Design 主题 manifest](https://github.com/rjsf-team/react-jsonschema-form/blob/main/packages/antd/package.json)
- 用普通字段、密码、多选、嵌套对象及音质条件字段完成实际页面；检验默认值、隐藏字段、空值、`additionalProperties` 和跨字段错误是否前后一致。
- Ajv standalone 输出经 Worker 构建与真实运行验证：没有运行时动态代码生成，所需 runtime 被打包，错误路径可映射到前端字段。
- 同一插件两个实例的 Schema、草稿、错误和凭据不串用；缓存键包括插件安装版本和声明版本。Schema 数据不包含凭据默认值。
- 插件音质依赖登录后能力时，区分静态配置结构、动态可选项和来源语义校验；不能为显示选项在核心硬编码平台档位。

## 3 插件包：采用 ZIP 库，保留领域包合同

`fflate` 提供纯 JavaScript 的 ZIP/DEFLATE、同步与流式解压；异步 API 通过 Web/Node Workers 运行。其 package exports 提供 `fflate/browser`。将浏览器入口的流式非线程 API 纳入双宿主验证，避开把 Cloudflare Worker 等同于可创建浏览器 Web Worker 的假设。[fflate README](https://github.com/101arrowz/fflate)、[exports](https://github.com/101arrowz/fflate/blob/master/package.json)

`zip.js` 官方明确支持 Bun，功能包括流式读写、Zip64、加密及多种 codec；其构建有 WASM、原生 JavaScript、core 等变体。其默认路径校验和可选归档检查可能减少安装器自有代码，即使当前插件包不需要额外压缩格式也值得比较。与 fflate 同批 PoC，按 Worker 适配、CPU/内存和实际安装器剩余代码选择，不只比较库体积。本轮没有找到其官方页面对 Cloudflare Workers 的明确运行承诺，不能由 Bun 支持推导 Worker 通过。[zip.js 兼容、构建及归档检查](https://gildas-lormeau.github.io/zip.js/)

ZIP 库负责归档机制，优先启用其已有检查。包管理仍负责 manifest 与公开合同、允许的 ESM 入口和模块列表、路径策略及所选库未覆盖的边界、压缩与实际解压总量限制、摘要与安装版本身份，以及安装失败不激活半包。流式条目的大小可能未知，不能只信归档里声明的 originalSize；对实际输出计数。fflate 的条目接口具有 `terminate()`，可在超过边界后停止条目处理。[UnzipFile 接口](https://github.com/101arrowz/fflate/blob/master/docs/interfaces/UnzipFile.md)

这里的边界属于安装合同，不扩展为自有 ZIP 格式实现；桌面写入暂存位置，Worker 组装模块，两者复用同一包解析结果。

接入时验证：发布版本和所选入口、Worker 构建不引入 Node worker/thread 能力、真实 Worker 的 CPU/内存预算、损坏归档/重复路径/超限输出、取消和失败清理。小包的 `unzipSync` 可作探针，但不能先假设完整缓冲与同步解压符合免费 Worker 预算。

## 4 版本兼容：用 npm semver

npm 的 `semver` 提供 `valid`、`validRange`、`satisfies`，支持范围与预发行语义，并有细粒度入口。优先用它，不手写版本分割、范围判断或预发行比较。[node-semver](https://github.com/npm/node-semver)

安装兼容判断由包管理执行，至少区分插件发布版本、插件合同支持范围、桌面/Worker 声明及状态 schema 版本。semver 负责语法和范围；宿主支持哪些能力、更新是否需要迁移、移除后是否可恢复仍是领域决定。默认使用严格解析，不能以 `coerce` 将无效 manifest 静默转换成另一版本。

接入时验证锁定版本的 ESM/CJS 打包、Worker 包体、预发行是否默认排除，以及非法/空范围的领域拒绝结果。版本范围相交不代表现有实例状态可安全升级；升级与回退策略须另外验证。

## 5 Worker 自动部署：官方 SDK 处理 API 机制

Cloudflare 官方 TypeScript SDK `cloudflare` 明确列出 Bun 和 Cloudflare Workers 为支持运行时，并自带类型化 API、错误与可配置超时/重试。优先用 SDK，避免维护第二套 HTTP 客户端、错误码分支及重试机制。[官方 SDK](https://github.com/cloudflare/cloudflare-typescript)

SDK 的 `workers.scripts.versions.create` 上传新版本而不立即部署，源码负责 multipart 编码；`workers.scripts.deployments.create` 负责发布指定版本。普通 Scripts 路线即可作为首个候选，不必默认依赖 SDK 中的 Beta Workers API。[版本源码](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/versions.ts)、[部署源码](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/deployments.ts)、[上传版本 API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)

本项目负责形成确定的发布计划：预构建核心、插件模块和生成注册入口的模块清单；期望插件集合及版本身份；应保留的 D1、Secrets、静态资源与设置；上传完成后发布并核对实际结果。SDK 上传成功不等于插件已激活。网络结果不明时需要查询和核对实际发布，不能先把本地记录改成成功，再依靠重试修补。

还需决定操作串行化和写入条件，保证旧安装任务不能覆盖新插件集合。配置与内容放在独立持久层；凭据不进入模块或页面。SDK 低层重试只负责请求恢复，整体安装/迁移/切换不是可盲目重复的一次 HTTP 请求。

接入时验证所选 SDK 发布版是否具备所需模块上传和部署接口；按所选版本的实际类型传递 File/Uint8Array 等数据。核对包体、依赖裁剪、超时、绑定继承与资产引用、上传和部署权限、结果不明恢复、在途播放影响。SDK runtime 支持不能证明免费计划资源预算或自部署流程已通过。

## 6 模块方向：用 dependency-cruiser 执行检查

`dependency-cruiser` 能检查 TypeScript 导入图、循环和 forbidden 依赖规则，也有 `reachable` 检查间接依赖；可读取 tsconfig 的解析配置。适合把领域和宿主边界变成开发检查，不自行写一套路径扫描器。[项目与规则](https://github.com/sverweij/dependency-cruiser)、[规则参考](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)、[tsconfig 支持](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md)

建议规则覆盖：公开插件合同不得依赖核心实现、前端或宿主；示例插件只引用公开合同；目录领域不得导入平台 SDK；Worker 入口不可间接触达桌面进程/磁盘适配；WebUI 不导入后台私有实现。类型与运行时依赖按实际合同分别处理，不为了规则省事把一切类型移入无所有者的 shared。

ESLint 的 `no-restricted-imports` 适合快速阻止显式错误导入，但官方注明仅检查静态 import；不能用单条规则证明动态加载和整个依赖图都符合边界。[ESLint 规则](https://eslint.org/docs/latest/rules/no-restricted-imports)

开发期优先用 dependency-cruiser 完成图检查，若项目已引入 ESLint，再使用其规则提供编辑器即时反馈；不为重复同一种职责先装多套架构插件。依赖图检查不执行外部插件，也不是插件隔离沙箱。

接入时核对选定版本的 Node engines；上游 main 的运行要求可能高于当前 CI。该工具仅在开发和 CI 运行，不进入 Bun 发行物或 Worker。验证 TS path alias、type-only import、重导出与字面量动态 import 的解析，宿主构建作为额外的实际边界证据。[dependency-cruiser manifest](https://github.com/sverweij/dependency-cruiser/blob/main/package.json)

## 7 建议验证顺序

1. 冻结最小公开合同和 JSON 配置声明，在一个独立最小插件上验证后端校验及表单；再加入示例插件的配置。
2. 同批验证 `zip.js` 与 `fflate` 的包解析、归档边界及模块清单，比较 Worker 适配、CPU/内存和实际安装器剩余代码；用 `semver` 验证兼容拒绝，随后验证 Bun 外置加载和 Worker 上传组装。
3. 以官方 SDK 跑通版本上传、部署结果核对和状态保留；没有授权与环境时先完成纯模块组装，部署事实保持待验。
4. 工程目录建立后加入 dependency-cruiser 规则，随第一条真实链路运行，不等待模块已相互穿透后再补规则。

以上均为候选设计与待验项目；本报告没有把任何新增依赖写成已集成或双端运行通过。

## 8 替代方案与使用成本

本节补查日期：2026-10-20。只依据维护方文档与源码比较，不代表新增依赖已经接入。取舍以本项目“插件提供可序列化配置、安装后无需重新构建 WebUI、Bun 与 Worker 两宿主”为前提；以下推荐均为设计判断。

### 8.1 RJSF 的替代：Formily、JSON Forms、React Hook Form

**Formily + Ant Design 是真实可选方案。** 维护方提供 Ant Design 适配仓库和 Ant Design 5 文档入口。其优势是复杂数组、布局和字段联动；Schema 同时包含 `x-component`、`x-decorator`、`x-reactions`，还支持 `{{表达式}}`、生命周期和执行语句。若把整套模型交给插件作者，公开配置合同会绑定 Formily 的组件与联动 DSL；若限定为纯数据子集，则需明确并维护这个子集。当前配置表单与认证步骤已分离，先验证 RJSF 更直接；复杂联动成为主要需求时应重新比较 Formily，不能以“没有现成 Ant Design 适配”排除它。[Formily Ant Design 适配](https://github.com/formilyjs/antd)、[维护方 Schema 与联动文档](https://github.com/alibaba/formily/blob/formily_next/packages/vue/docs/api/shared/schema.md)

**JSON Forms 与 RJSF 职责相近。** 它根据 JSON Schema、UI Schema 和 renderer 生成表单，属于直接竞争者。官方清单中的 React renderer 是 Material 与 Vanilla；保持当前 Ant Design 基线会增加 renderer 接入成本。若整个 WebUI 改为 Material UI，它会更有吸引力。不能因该清单没有 Ant Design，就断言不存在社区适配。[JSON Forms renderer 清单](https://jsonforms.io/docs/renderer-sets/)

**React Hook Form 主要管理开发者写出的表单状态和校验。** 它可与 Ant Design 等受控组件结合，也能使用 Ajv/Zod 等校验器；但官方基础用法仍需作者定义字段 JSX。单独用它替代 RJSF，项目还得实现 JSON Schema 到组件、数组、条件与错误的通用映射。它很适合 MusicFS 固定的登录或管理表单，并非插件动态配置的同等替换。[React Hook Form 官方仓库与基础示例](https://github.com/react-hook-form/react-hook-form)、[Controller 官方文档源码](https://github.com/react-hook-form/documentation/blob/master/src/content/docs/usecontroller/controller.mdx)

### 8.2 Ajv 的替代：Zod 与 Valibot

**不能沿用“Zod 不支持 JSON Schema”的旧说法。** 当前 Zod 原生提供 `z.toJSONSchema()`，也提供从 JSON Schema 读取的 `z.fromJSONSchema()`；后者被官方明确标为 Experimental。前者不能无损表达 transform、Date 等所有 Zod 能力。作者可以用 Zod 生成合同允许的 JSON Schema，但这不等于它已成为稳定、完整的外部 JSON Schema 执行器。当前官方工具链/示例优先验证 Ajv 的标准配置校验与 standalone 生成；第三方插件可自选内部校验库，内部 DTO 使用 Zod 也不冲突。[Zod JSON Schema 官方文档](https://zod.dev/json-schema)

**Valibot 也能生成 JSON Schema。** 官方 `@valibot/to-json-schema` 支持 draft-07、draft-2020-12 等目标；官方同时说明转换有不支持特性和语义差异。Valibot 的模块化设计适合减少内部校验的打包体积；本轮官方资料提供的是 Valibot → JSON Schema 转换，未给出与 Ajv standalone 等价的通用 JSON Schema 执行/生成路线。因此可以作为插件作者编写校验的工具，不能因“更小”就直接取代本项目的 JSON Schema 合同与 Ajv。也不应要求所有插件内部统一使用同一个校验库。[Valibot JSON Schema 指南](https://valibot.dev/guides/json-schema/)、[转换包及限制](https://github.com/open-circle/valibot/tree/main/packages/to-json-schema)

### 8.3 fflate 的替代：zip.js 与 JSZip

**zip.js 是值得进入同一 PoC 的强候选。** 官方明确支持 Bun、Web Streams、Zip64、加密及多种构建；当前文档还提供默认不安全路径拒绝、可选重复条目/重叠/CRC 检查。这些能减少包安装器的通用解析代码，价值不限于支持更多压缩格式。代价是需要选定 native/core 等入口，配置 Web Workers/WASM，并验证 Cloudflare Worker；官方 Bun 支持不能证明 Worker 兼容。项目仍负责模块清单、条目数量、实际解压总量和安装事务。[zip.js 官方兼容、构建与不可信 ZIP 说明](https://gildas-lormeau.github.io/zip.js/)

**fflate 的优势是专注的纯 JavaScript 实现和流式 ZIP API。** 本项目目前只需要受限插件 ZIP，所以它仍是合理候选；但其 chunk 回调需要接入宿主流与边界检查。不能仅比较库宣称的压缩后体积，就认定整体实现成本一定小于 zip.js。两者同批 PoC，最终选择应看 Worker 构建、实际 CPU/内存和安装器剩余代码。[fflate 官方流式 ZIP 与入口说明](https://github.com/101arrowz/fflate)

**JSZip 更适合简单的内存式归档操作。** 它并非“没有流式能力”：官方提供 StreamHelper 和 Node stream；但常用 `async()`/`generateAsync()` 会把完整结果留在内存。Worker 需要 Web Streams，采用它会增加流接线与预算验证的工作，因此当前不优先；小而有严格上限的包仍可使用。[JSZip 官方限制](https://stuk.github.io/jszip/documentation/limitations.html)

### 8.4 semver 的替代：缩减兼容规则

若公开插件协议只接受 `apiVersion: 1` 这样的整数，并按显式支持集合判断，确实可以暂不引入 semver；这是缩减协议能力，仍是合理的产品设计，不是要求手写半套 semver。一旦对作者承诺 `^1.2.0`、`>=1.2 <2` 或预发行范围，就应复用成熟解析器。npm semver 已定义这些边界和预发行规则，手写字符串切分/大小比较会重新承担同一工作。当前没有证据证明更换另一范围解析库能带来明确收益。[npm semver 范围与预发行规则](https://github.com/npm/node-semver)

### 8.5 dependency-cruiser 的替代：Madge、ESLint 或先不加图工具

**Madge 偏向观察依赖图和定位循环。** 它能导出图、查询依赖及找循环，适合临时排查；如果目标只是查看图，它足够。MusicFS 还要持续执行领域、插件合同与宿主方向规则，dependency-cruiser 的规则和间接可达检查更贴近目标，避免基于 Madge 输出再写一层规则引擎。[Madge 官方功能](https://github.com/pahen/madge)、[dependency-cruiser 间接可达规则](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)

**ESLint boundaries 是合理替代。** 它可声明架构元素、公共入口和允许依赖，并在已有 ESLint 流程中反馈；主要需求若是直接模块边界，可只选它。需要完整依赖图、循环及跨中间模块的可达约束时，优先 dependency-cruiser。当前应选一套主要规则工具，避免同时维护两套同义规则。[eslint-plugin-boundaries 官方仓库与规则示例](https://github.com/javierbrea/eslint-plugin-boundaries)

**工程很小时，也可以先用现有 ESLint `no-restricted-imports` 与公开包入口。** 该规则仅覆盖静态 import，不能宣称等价于完整图验证。是否暂不引入图工具，应根据是否已有跨层/双宿主边界需要自动守住来决定；本项目已有明确隔离需求，因此在第一条真实模块链路出现时引入 dependency-cruiser 是适度的开发保障，不是运行时架构依赖。[ESLint 官方规则边界](https://eslint.org/docs/latest/rules/no-restricted-imports)
