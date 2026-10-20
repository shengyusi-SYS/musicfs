# 数据源插件 Interface 草案

日期：2026-10-20。状态：P0 草案，尚未发布稳定插件 SDK。依据：[领域与模块设计](README.md)、[术语](../../outputs/GLOSSARY.md)、[插件决定](../adr/0001-installable-source-plugins.md)。本文负责调用与数据合同，不重复管理路由、用户需求或宿主实现。

首轮可类型检查的精确定义见 [plugin-api 源码](../../packages/plugin-api/src/index.ts)，预构建包见[最小插件构建入口](../../scripts/build-sample.ts)，实际覆盖见[P0 记录](../verification/p0-plugin-foundation.md)、[通用认证](../verification/p1-authentication.md)及[候选迁移](../verification/p2-plugin-migration.md)。公开类型不替代真实来源、续期及云端验收。

## 包与版本

当前宿主合同版本为 **0.1.5**，新增可选的按需会话续期。使用续期能力的插件声明 `apiRange >=0.1.5 <0.2.0`；0.1.4 的候选转换和整体迁移激活、0.1.3 的文件条目完整 `info`、0.1.2 的目录计数和0.1.1的二维码图片仍有效。旧插件无需声明续期；未提供 info 时保持原 stat 行为，不自动获得大目录的请求预算保证。

首轮验证 ZIP 插件包，采用现成归档库解析。包内有一份 manifest、预构建 ESM 入口及依赖模块、JSON 配置 Schema、UI 提示和必要只读资产/许可；模块和资产路径在 manifest 中明确列出，不运行安装脚本或在线安装 npm 依赖。

manifest 表达 `id`、`version`、`apiRange`、支持的宿主和各宿主入口、配置/私有状态 schema 版本及资源清单。包摘要确定实际安装内容身份，插件版本描述作者发布身份；同版本不同内容不能静默覆盖。兼容解析使用 npm semver，归档解码从 zip.js 与 fflate 的同轮 PoC 中选择；通用归档检查尽量交给库，包内容与激活规则由 `extensions` 执行。

插件在作者构建时处理 npm 与资源依赖，仅将公开 `plugin-api` 作为受约定的外部合同；不得引用核心私有模块。双端可使用不同构建入口，但对同一来源实例遵守相同业务合同。桌面本机依赖声明为桌面能力，不进入 Worker 产物。包的正式字段和路径由最小插件验证后固定。

## 配置与能力声明

配置使用 JSON Schema draft-07 的已验证关键字，UI 提示使用可序列化的字段路径、顺序及支持的 widget 标识。首版只承诺通用表单，不把 RJSF 的全部扩展选项公开给插件。

官方工具链和示例插件优先用同一 Schema 生成 Ajv standalone ESM 结构校验并随入口发布，核心不在 Worker 中执行 `Ajv.compile`。第三方插件可选择自己的内部校验库，公开合同要求 Schema、校验结果和宿主能力一致，不强制依赖 Ajv。插件可在保存前执行来源语义检查；网络检查是可取消的来源操作，不放在同步 SQL 事务内。

登录后才知道的选项由插件以数据补充，静态 Schema 描述结构和值的基本类型，插件负责当前实例的有效值检查。动态选项不意味着后端必须编译新的 Schema。校验错误返回字段路径和原因，前端可显示来源错误而不理解音质含义。

Schema、UI 提示和管理响应不能携带私有授权默认值。音质、服务器地址等配置按实例保存；没有账号或音质的插件无需声明相应能力。认证是单独的步骤合同，不塞进表单渲染器内部。

当前有限 UI 提示中，`order` 是根属性的顺序，未列出的属性由宿主补齐；`widgets` 的键使用根属性名或 JSON Pointer（例如 `/server/token`），值仅允许 `password`、`textarea`、`uri`。字段错误 `fields[].path` 同样采用 JSON Pointer。前端负责翻译到表单库，插件不依赖 RJSF 的组件或内部配置对象。

## 最小操作面

下面是用于 P0 的类型轮廓，省略显示名称、分页统计等辅助 DTO；只约束职责与字节合同，不作为已发布 ABI。

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Ref = string; // 插件给出的稳定、不透明引用，核心不按字符解析来源含义
type Page<T> = { items: T[]; nextCursor?: string };
type ByteRange = { start: number; end: number }; // 闭区间

type PluginFault = {
  kind: 'invalid_config' | 'needs_auth' | 'not_found' | 'unavailable'
    | 'rate_limited' | 'temporary' | 'not_supported' | 'content_changed';
  message: string;
  retryAfterSeconds?: number;
};

type Outcome<T> = { nextPrivateState?: Json } & (
  | { ok: true; value: T }
  | { ok: false; error: PluginFault }
);

type Context = {
  instanceId: string;
  config: Json;
  privateState: Json; // 当前调用的快照；不允许原地写数据库
  signal: AbortSignal;
  fetch: typeof fetch; // 标准请求能力，允许测试与宿主预算接线
};

type Entry =
  | { kind: 'directory'; entryId: string; name: string; directoryRef: Ref }
  | { kind: 'file'; entryId: string; name: string; fileRef: Ref; info?: FileInfo };

type Root = { sourceId: string; name: string; directoryRef: Ref };
type FileInfo = {
  contentId: string;
  size: number;
  mediaType: string;
};
type ReadRequest = { expectedContentId: string; range?: ByteRange };
type ReadResult = {
  content: FileInfo;
  servedRange: ByteRange | null; // null 表示实际提供完整文件
  body: ReadableStream<Uint8Array>;
};

interface SourcePlugin {
  // config 的结构及来源语义校验；字段错误 DTO 在正式定义中展开
  validateConfig(ctx: Context, candidate: Json): Promise<Outcome<Json>>;
  roots(ctx: Context, cursor?: string): Promise<Outcome<Page<Root>>>;
  list(ctx: Context, directory: Ref, cursor?: string): Promise<Outcome<Page<Entry>>>;
  stat(ctx: Context, file: Ref): Promise<Outcome<FileInfo>>;
  open(ctx: Context, file: Ref, request: ReadRequest): Promise<Outcome<ReadResult>>;
  // 声明认证的插件提供；action/step 是下文约定的判别联合 DTO
  authenticate?(ctx: Context, action: Json): Promise<Outcome<Json>>;
  renewal?: {
    needed(ctx: Context): boolean | Promise<boolean>; // 纯本地判断，不发网络请求
    renew(ctx: Context): Promise<Outcome<null>>;
  };
  // 无 I/O 的候选转换和验证；宿主决定何时提交
  migrateConfig?(input: { fromVersion: number; config: Json; state: Json }): Json;
  migrateState?(input: { fromVersion: number; state: Json; config: Json }): Json;
  validateState?(input: { config: Json; state: Json }): boolean;
}
```

业务数据和错误保持可序列化；`fetch`、`AbortSignal` 与音频 `ReadableStream` 是明确约定的原生能力，不是可放进 manifest 的任意函数。实际模块导出方式、精确 DTO 和字段错误类型在 P0 中补齐；公开合同不引入框架对象或通用状态机库。

`validateConfig` 的成功值是要保存的配置；输入按插件 Schema 结构检查并作来源语义检查。失败不改当前配置。结构校验可来自生成代码，不能为此在核心实现新的 JSON Schema 引擎。

## 稳定身份、分页与目录

插件身份、安装修订、实例身份、`sourceId`、`entryId`、`fileRef` 和 `contentId` 分别有意义。`entryId` 在其来源目录中稳定地标识一次出现，重名项和同曲重复位置可保留不同条目；`fileRef` 可关联同一实际文件，`contentId` 对应一份实际字节表示，临时 URL 不作为这些身份。

配置影响了编码或实际内容时，插件应输出相应新文件身份或内容身份；不能在旧内容身份下静默返回另一份音频。更换实例显示名称或拖拽目录不改变来源身份。

`nextCursor` 仅在本轮相同实例上下文和目录下使用；没有下一页才表示该页序列完整。空页附带下一游标并不表示空目录。分页失败返回错误，不能当作最后一页；循环游标和超出本次预算应形成可诊断失败/续作状态，不能发布截断的成功快照。

`roots` 提供可被用户放入布局的内容源，`list` 提供该来源目录中的有序子项。插件自行决定分类、音质选择和隐藏；统计可作为额外数据报告，核心不把文件数当曲目数。来源只提供普通音频文件夹时，也不需要伪造歌单或推荐入口。

0.1.2 的 `SourcePlugin.statistics?: Record<string,string>` 声明计数的显示标签；没有统计概念的插件可以省略。最多 100 项，键长 1—64、标签长 1—80；声明不携带 UI 代码或核心音质枚举。`Page.statistics` 是**本页增量**的非负安全整数计数，不是累计总数或平均值；同一分页序列各页使用相同键集。核心检查、相加并在完整成功快照中保存，失败、溢出或不一致不覆盖旧目录/计数。管理界面按插件标签显示已保存计数及最近成功时间；不从文件数推断曲目或权限。旧快照无统计时保持未知，不补零。QQ 的实际应用与验证见[音质/统计记录](../verification/p2-qq-quality.md)。

0.1.3 的文件 `Entry.info` 是该 fileRef 对应实际字节的完整 `{contentId,size,mediaType}`，与 stat 使用相同语义；不是 size_* 提示、试听大小、短 URL 或将来才能兑现的描述。来源未知时省略整个字段，不填零或虚构内容版本。核心校验后随有序目录页持久化，完整目录成功才发布，失败不覆盖旧内容。新版示例插件均在本页准备好信息：网易云复用原生精确 MD5/大小，QQ 用有界小页和真实 Range 响应确认；需要多少来源工作由插件决定。

DAV 从已发布信息批量描述条目，来源有效性按同一来源戳在批量前后检查；单条 stat、HEAD 和 open 的实际版本检查仍保留。旧插件缺少 info 时可沿原 stat 回退，不能把该兼容路径当作大目录免费 Worker 已通过。条目信息不强制所有来源具备账号、歌曲或音质概念。

## 描述、打开与范围读取

`stat` 返回与一份实际字节表示对应的准确大小、类型和内容身份，未知大小不能填写零。暂未就绪返回可重试的技术错误，不得替换成无播放权限；可复用来源批量元数据或有界探测，不下载整曲取大小。

`library` 先取得描述，检验客户端范围，再用期望 `contentId` 调用 `open`。后缀和开放尾部 Range 在协议/读取接线处归一为有效闭区间；多范围的首版行为由统一 HTTP 合同决定，插件不解析原始 HTTP Range 字符串。

插件返回的是实际读取事实：`servedRange: null` 对应完整文件，范围对象对应实际提供的区间。`library` 核对内容身份、总长度、区间和预期，再由共用 DAV 层生成正确的 200/206/416 及响应头。完整上游 200 不能隐瞒成部分流；当前在正文交付前拒绝这类范围不匹配，见 [ADR 0004](../adr/0004-shared-fetch-readonly-dav.md)。

临时地址失效后可以重新定位同一表示。若表示已变化，在发出正文前返回 `content_changed`，上层重新核对元数据或向客户端返回适当结果；正文已开始后不得从头重试、换编码或拼接另一文件。

使用原生流背压，客户端取消要到达插件真正的上游请求。`open` 返回后的错误也必须经流传播，不以正常 EOF 掩盖截断；错误流的清理由该次读取接线负责。大文件不得在核心、插件或 DAV Adapter 全量缓冲，临时 URL 和敏感请求头留在插件内部。

## 认证与私有状态

正式认证 DTO 使用明确步骤：等待/二维码、打开链接、输入字段/验证码、成功、过期、失败；用户可取消。action 表达开始、查询、提交输入与取消，挑战状态由插件解释、由 `sources` 关联到唯一实例、操作和代际。

认证表单复用公开 Schema 和字段错误，不放入任意 React 组件；前端只获取当前交互需要的数据。来源无需认证时无需提供 authenticate，核心不能显示必填扫码页面。

`waiting.qrCode` 是待编码的文字载荷，由宿主本地生成二维码；0.1.1 的可选 `qrImage` 是来源已生成的内嵌 PNG/JPEG（仅 base64 data URI，最多 350,000 字符），页面在提供图片时优先显示它。宿主拒绝远程图片 URL、SVG 和超长值；插件如需取得远程二维码图片，在插件内请求、检查类型/大小并转换。`url` 是可选的 HTTP(S) 授权页面地址。waiting/input 的 challengeId 与 expiresAt 必须有效；submit 只用于当前 input，poll 只用于当前 waiting。插件可在新步骤中更换 challengeId。管理端的 operationId 属于宿主，不进入插件 action。

交互步骤在 SQLite/D1 保存，公开投影可在页面或宿主重启后恢复。开始、完成、取消及过期终态使旧调用失效；完成前后各有一次代际推进，以清除等待期间的旧内容。取消先写入宿主状态，再向插件发送当前挑战的 cancel；只有明确 cancelled 的清理结果可提出私有状态更新，不能借清理响应重新完成授权。

插件执行获得 `privateState` 快照，通过结果中的 `nextPrivateState` 提出完整的新私有状态。`sources` 使用自己捕获的实例代际和私有状态 CAS 版本提交，而不是接受插件自报的“当前版本”。过期结果不覆盖授权；并发状态变化要核对、合并或重新调用，不能盲目 last-write-wins。

业务结果与已确认的授权变化分别处理：例如 token 已续期、随后目录请求失败，失败结果仍可携带新授权状态，经同样的代际/CAS 检查保存；`library` 仍不得发布失败目录。不能因为整个调用失败就丢弃已发生的必要状态变化，也不能因为有新状态就把失败内容当成功。

这份私有状态用于必要授权与来源流程状态，不承载整份公共目录或音频缓存。超大来源状态、必要批量缓存等真实需求出现时，在宿主存储 seam 扩展有明确所有者的操作，不直接暴露数据库或通用任意写入能力。

## 按需会话续期

0.1.5 的 `renewal` 是可选能力，不要求来源具备账号。`needed` 只检查当前私有状态与本地时间；来源有效期、提前量和重试策略仍归插件。`sources` 在 roots/list/stat/open 前调用它，配置检查与交互认证走原合同。返回 false 或未声明能力时不取得续期租约，普通内容操作保持并发。

确需续期时，宿主按实例在 SQLite/D1 条件取得短租约，同时预留一个私有状态修订；网络请求在事务外执行。预留修订及普通写入检查防止旧调用的完整状态覆盖新凭据。完成时原子保存可选新状态、公开错误与短期重试时间，并释放租约；其他控制器等待后读取新状态或复用该次失败，不依赖 Worker isolate 内存。配置、交互认证或插件代际变化使旧续期不能提交。续期不改变实例代际，不作换号处理，也不使成功目录失效。

当前租约60秒、续期操作信号25秒、等待预算25秒；等待可取消，取消一个等待者不取消另一调用的续期。插件应把信号传到真实 Fetch，不以租约替代取消。已发生的凭据变化由 `renew` 的 `nextPrivateState` 独立提交，之后内容读取失败也不会丢失。插件可把成功检查/临时失败的下次检查时间保存在私有状态；核心不解释 token、有效期或登录渠道，也不增加定时登录。实现及限定证据见[会话生命周期](../verification/p2-session-lifecycle.md)。

## 配置与私有状态迁移

`configVersion`、`stateVersion` 分别描述配置和私有状态的数据结构版本，与插件包的 SemVer 区分。只有对应结构版本变化才调用其转换：`migrateConfig` 接收旧配置/旧状态，`migrateState` 接收旧状态和已转换配置。转换为同步纯函数，返回完整 JSON 候选；不执行 I/O、修改当前持久数据或启动后台任务。

有受影响实例的结构升级必须提供相应转换函数和 `validateState`。宿主复制并校验 JSON，先检查目标状态，再以候选配置/状态调用可取消的 `validateConfig`，接受其规范化配置及可选 `nextPrivateState`，最后再次验证目标状态。任何一步拒绝、抛错或返回非 JSON 都使整个更新失败。结构版本不变的兼容更新不运行这些钩子，也不强制已有插件新增它们；没有实例时无需转换数据。

安装用例一次冻结当前实例集合及每个实例的配置、状态、代际和状态修订，逐实例保存候选。最后在同一个 SQLite 事务或 D1 batch 中，条件切换安装记录、**全部**实例候选及操作终态；任何实例被新增、删除、配置/授权变化或安装代际改变，均拒绝整体切换。成功后实例 ID、名称和布局保留，实例代际/状态修订递增并清除旧交互认证记录；旧请求及旧目录快照不能写回。

桌面端先加载不可变候选修订，后台可跨重启继续。Worker 先冻结输入再发布包含新旧代码的集合；核对上传成功后，必须由确实包含目标 `(pluginId, revision)` 模块的后续调用执行迁移与激活，旧调用不会拿旧模块迁移。失败保留旧安装和全部活动数据；终态清理暂存候选，不提供任意回滚图或跨代码发布/数据库的事务。实测范围见[迁移验证](../verification/p2-plugin-migration.md)。

## 错误与生命周期

标准错误 kind 供核心选择通用响应和重试，来源可提供不含秘密的具体说明。`needs_auth` 与 DAV 密码错误区分，`unavailable` 与网络/解析错误区分，`not_found` 与未完成刷新区分。音质缺失是否隐藏或回退在插件内处理，不新增核心全局错误策略。

意外异常由调用 seam 转换为诊断失败；正常空目录、明确的来源不存在和临时故障不可相互混用。核心只在有证据的范围有限重试，并与 SDK/平台库的重试配合，避免多层相乘。

每次调用由宿主绑定到实际已加载插件修订和实例代际。更新/移除后旧任务不能写回状态或发布目录；取消信号使慢操作尽快结束。普通数据状态不可依赖插件全局变量；Worker isolate 重建或桌面重启后从实例持久状态恢复。

## P0 合同验证

- 独立最小插件仅引用公开类型，声明普通配置，提供一个目录和固定字节文件；同包两实例独立工作。
- 前端表单与作者生成的后端结构校验使用同一 Schema，复杂字段、默认值与错误路径一致，Worker 不动态生成校验代码。
- 内容分页、重复出现、中文/重名路径、未知大小、明确无权限和临时错误得到各自结果，不发布截断快照。
- Range、上游忽略 Range、内容换版、流截断、取消及背压经过真正的 `library`/DAV 接线验证。
- 换配置、换号、认证取消、更新、移除与实例删除后，旧调用结果均不能改变新状态。
- Bun 编译产物外置加载与真实 Worker 注册/部署分别验证；接口类型兼容不替代运行验证。
