# 数据源插件开发合同

[English](../en/plugin-interface.md)

本文对应开发版公开 API。本文定义插件的数据与调用要求；架构取舍、历史验证与当前支持范围由完整源码仓库的文档索引和验收台账维护。

可类型检查的精确定义见[plugin-api源码](../../packages/plugin-api/src/index.ts)，预构建包见[最小插件构建入口](../../scripts/build-sample.ts)。这些文件与本合同一起包含在独立作者包中；公开类型不替代真实来源、续期及云端验收。

从独立作者包修改示例、构建 ZIP 并安装到现有服务，见[插件作者指南](../plugin-authoring.md)。

## 包与版本

当前宿主合同版本为 **0.1.12**，提供可选的插件名称、配置及消息翻译；0.1.11的可选命名资料继续有效。内容配置身份、显式音乐资料更新、缓存及批量/原子缓存操作、延迟文件信息、分页进度、续期和迁移仍按各自可选合同声明。不采用新能力且有兼容回退的插件可保留原兼容范围；使用新的清单字段时要求API0.1.12。旧插件无需增加账号、缓存或补标签能力；缺少 info 且未声明 deferredInfo 时保持原 stat 行为。

插件使用预构建 ZIP 包，宿主用归档库解析。包内有一份 manifest、预构建 ESM 入口及依赖模块、JSON 配置 Schema、UI 提示和必要只读资产/许可；模块和资产路径在 manifest 中明确列出，不运行安装脚本或在线安装 npm 依赖。

manifest 表达 `id`、`version`、`apiRange`、支持的宿主和各宿主入口、配置/私有状态 schema 版本及资源清单。包摘要确定实际安装内容身份，插件版本描述作者发布身份；同版本不同内容不能静默覆盖。兼容解析使用 npm semver，运行时归档使用 zip.js；通用归档检查尽量交给库，包内容与激活规则由 `extensions` 执行。

插件在作者构建时处理 npm 与资源依赖，仅将公开 `plugin-api` 作为受约定的外部合同；不得引用核心私有模块。双端可使用不同构建入口，但对同一来源实例遵守相同业务合同。桌面本机依赖声明为桌面能力，不进入 Worker 产物。精确字段以公开类型为准。

## 配置与能力声明

配置使用 JSON Schema draft-07 的已验证关键字，UI 提示使用可序列化的字段路径、顺序及支持的 widget 标识。首版只承诺通用表单，不把 RJSF 的全部扩展选项公开给插件。

官方工具链和示例插件优先用同一 Schema 生成 Ajv standalone ESM 结构校验并随入口发布，核心不在 Worker 中执行 `Ajv.compile`。第三方插件可选择自己的内部校验库，公开合同要求 Schema、校验结果和宿主能力一致，不强制依赖 Ajv。插件可在保存前执行来源语义检查；网络检查是可取消的来源操作，不放在同步 SQL 事务内。

登录后才知道的选项由插件以数据补充，静态 Schema 描述结构和值的基本类型，插件负责当前实例的有效值检查。动态选项不意味着后端必须编译新的 Schema。校验错误返回字段路径和原因，前端可显示来源错误而不理解音质含义。

Schema、UI 提示和管理响应不能携带私有授权默认值。音质、服务器地址等配置按实例保存；没有账号或音质的插件无需声明相应能力。认证是单独的步骤合同，不塞进表单渲染器内部。

当前有限 UI 提示中，`order` 是根属性的顺序，未列出的属性由宿主补齐；`widgets` 的键使用根属性名或 JSON Pointer（例如 `/server/token`），值仅允许 `password`、`textarea`、`uri`。字段错误 `fields[].path` 同样采用 JSON Pointer。前端负责翻译到表单库，插件不依赖 RJSF 的组件或内部配置对象。

`manifest.nameTranslations` 可提供按语言命名的插件名称，`configuration.translations` 可提供按语言、原文键组织的词典；动态错误可附带 `translation: {key, values}`。它们都是可选显示资料，不改变来源配置、内容名称、文件身份或读取能力。具体格式见[显示翻译](../plugin-authoring.md#显示翻译)，宿主接线见[国际化设计](i18n.md)。

## 保留策略与资料更新

`contentConfiguration`可从规范化配置中排除纯保留策略。输入相同身份且私有状态未变时，宿主保存配置但保留内容代际、授权、快照及资料；不提供此方法的插件保持原失效行为。不能排除账号、服务器、音质等会改变访问内容的字段。保留天数作用于后续写入，既有资料按原期限复用。

需要主动更新资料的插件声明`metadataRefresh: true`。宿主仅在用户选择该操作时，在分页`list`中同时传入`fileInfo: required`和`metadataRefresh: operationId`；插件按该ID绕过以前的资料/准备索引，同一操作内复用新取得的共用资料。新资料生成新表示，不能覆盖旧引用依赖的不可变计划。分页、冷却、取消与完整发布仍沿用目录刷新。未声明能力的插件不会显示此入口。

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
  fileInfo?: 'required'; // 文件准备遍历：每个文件须返回准确 info，或明确失败
  metadataRefresh?: string; // 用户明确要求重新获取资料，同一操作各页共用此ID
  cache?: {
    get(key: string): Promise<Json | undefined>;
    put(key: string, value: Json, options?: { expiresAt?: number }): Promise<void>;
    putIfAbsent?(key: string, value: Json): Promise<Json>;
  };
};

type Entry =
  | { kind: 'directory'; entryId: string; name: string; directoryRef: Ref }
  | { kind: 'file'; entryId: string; name: string; fileRef: Ref;
      info?: FileInfo; deferredInfo?: true;
      naming?: { identity: string; fields: Record<string, string | number | string[]> } };

type Root = { sourceId: string; name: string; directoryRef: Ref };
type FileInfo = {
  contentId: string;
  size: number;
  mediaType: string;
  modifiedAt?: string; // ISO时间；该实际字节的修改时间，非本次扫描时间
};
type ReadRequest = { expectedContentId: string; range?: ByteRange };
type ReadResult = {
  content: FileInfo;
  servedRange: ByteRange | null; // null 表示实际提供完整文件
  body: ReadableStream<Uint8Array>;
};

interface SourcePlugin {
  contentConfiguration?(config: Json): Json; // 纯函数，返回影响内容/认证的配置
  metadataRefresh?: true; // 声明理解 Context.metadataRefresh
  naming?: { fields: Record<string, string> }; // 可选命名字段及界面标签，不强制音乐领域
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

业务数据和错误保持可序列化；`fetch`、`AbortSignal` 与音频 `ReadableStream` 是明确约定的原生能力，不是可放进 manifest 的任意函数。精确 DTO 和字段错误类型见公开类型；公开合同不引入框架对象或通用状态机库。

`validateConfig` 的成功值是要保存的配置；输入按插件 Schema 结构检查并作来源语义检查。失败不改当前配置。结构校验可来自生成代码，不能为此在核心实现新的 JSON Schema 引擎。

## 稳定身份、分页与目录

插件身份、安装修订、实例身份、`sourceId`、`entryId`、`fileRef` 和 `contentId` 分别有意义。`entryId` 在其来源目录中稳定地标识一次出现，重名项和同曲重复位置可保留不同条目；`fileRef` 可关联同一实际文件，`contentId` 对应一份实际字节表示，临时 URL 不作为这些身份。

配置影响了编码或实际内容时，插件应输出相应新文件身份或内容身份；不能在旧内容身份下静默返回另一份音频。更换实例显示名称或拖拽目录不改变来源身份。

`nextCursor` 仅在本轮相同实例上下文和目录下使用；没有下一页才表示该页序列完整。空页附带下一游标并不表示空目录。分页失败返回错误，不能当作最后一页；循环游标和超出本次预算应形成可诊断失败/续作状态，不能发布截断的成功快照。

`roots` 提供可被用户放入布局的内容源，`list` 提供该来源目录中的有序子项。插件自行决定分类、音质选择和隐藏；统计可作为额外数据报告，核心不把文件数当曲目数。来源只提供普通音频文件夹时，也不需要伪造歌单或推荐入口。

0.1.2 的 `SourcePlugin.statistics?: Record<string,string>` 声明计数的显示标签；没有统计概念的插件可以省略。最多 100 项，键长 1—64、标签长 1—80；声明不携带 UI 代码或核心音质枚举。`Page.statistics` 是**本页增量**的非负安全整数计数，不是累计总数或平均值；同一分页序列各页使用相同键集。核心检查、相加并在完整成功快照中保存，失败、溢出或不一致不覆盖旧目录/计数。管理界面按插件标签显示已保存计数及最近成功时间；不从文件数推断曲目或权限。旧快照无统计时保持未知，不补零。

0.1.3 的文件 `Entry.info` 是该 fileRef 对应实际字节的完整 `{contentId,size,mediaType}`，与 stat 使用相同语义；不是 size_* 提示、试听大小、短 URL 或尚未确定尺寸和版本的描述。来源未知时省略整个字段，不填零或虚构内容版本。核心校验后随有序目录页持久化，完整目录成功才发布，失败不覆盖旧内容。QQ 在有界分页内准备最终信息；网易云示例 对已确定上游大小的 MP3/FLAC/M4A 以合法固定填充预先确定最终大小，首次 GET 才准备单曲标签，目录和 HEAD 可直接使用已发布描述。显式延迟信息路径也可继续使用。

0.1.8 的 `Entry.deferredInfo: true` 是插件主动选择两阶段准备的标记，仅在没有完整 `info` 时生效。普通 `list` 可以返回稳定 `fileRef`、名称和类型，单文件 `stat` 必须能按需取得准确的最终描述；首次 GET 也先走这一描述，再 `open`。核心保存待准备文件数，不把未准备误作无权限或空文件。未声明标记的旧插件继续实时 stat，不被改为后台准备。

批量属性需要完整信息时，宿主通过既有持久刷新以 `file-info` 范围重新分页调用 `list`，并设置可选 `Context.fileInfo: 'required'`；此时每个文件都须提供准确 `info`，无法完成则返回明确故障，不能继续只给 deferredInfo。它使用原有游标、检查点、取消、重试、预算和完整目录原子发布；准备期间保留原清单，失败保留最近成功内容。该提示表达通用文件准备要求，不强制音乐字段或 tag API。

0.1.7 可选 `FileInfo.modifiedAt` 是该实际字节表示的有效ISO时间。插件在内容不变时保持它，内容变化时更新；核心在list、stat及DAV属性中使用，避免目录刷新引起所有文件mtime变化。它不是专辑发行日期，也不参与内容身份计算；缺省回退目录内容时间；无变化刷新保留该时间。

DAV的批量描述与单条stat/HEAD统一复用已发布的完整info，前后核对来源戳；缺少info的旧插件沿实时stat回退。显式延迟准备的目录仍可列名称；批量 `allprop` 或请求大小、媒体类型、ETag 时安排文件准备，正式延迟执行宿主返回整次请求的503及 `Retry-After`、`X-MusicFS-Refresh`，完成后重试。单文件HEAD/GET只按需准备该文件，GET/open仍核对期望内容身份、大小和实际范围，不因复用目录元数据而跳过真实字节核验。条目信息不强制所有来源具备账号、歌曲或音质概念；此流程也不代表所有播放器会自动重试或免费Worker已通过验收。

## 描述、打开与范围读取

`stat` 返回与一份实际字节表示对应的准确大小、类型和内容身份，未知大小不能填写零。暂未就绪返回可重试的技术错误，不得替换成无播放权限；可复用来源批量元数据或有界探测，不下载整曲取大小。

`library` 先取得描述，检验客户端范围，再用期望 `contentId` 调用 `open`。后缀和开放尾部 Range 在协议/读取接线处归一为有效闭区间；多范围的首版行为由统一 HTTP 合同决定，插件不解析原始 HTTP Range 字符串。

插件返回的是实际读取事实：`servedRange: null` 对应完整文件，范围对象对应实际提供的区间。`library` 核对内容身份、总长度、区间和预期，再由共用 DAV 层生成正确的 200/206/416 及响应头。完整上游 200 不能隐瞒成部分流；当前在正文交付前拒绝这类范围不匹配。

临时地址失效后可以重新定位同一表示。若表示已变化，在发出正文前返回 `content_changed`，上层重新核对元数据或向客户端返回适当结果；正文已开始后不得从头重试、换编码或拼接另一文件。

使用原生流背压，客户端取消要到达插件真正的上游请求。`open` 返回后的错误也必须经流传播，不以正常 EOF 掩盖截断；错误流的清理由该次读取接线负责。大文件不得在核心、插件或 DAV Adapter 全量缓冲，临时 URL 和敏感请求头留在插件内部。

### 音乐资料与可选补标签

`FileInfo` 中的大小、媒体类型和内容身份，不是歌曲、封面或歌词模型。来源插件可以完全透传、自带补标签实现，或在作者构建时选用第三方/共用工具；核心不强制标签能力、不二次改写文件，也不要求新增音乐字段或补标签方法。上游已带完整资料的文件不需要重复处理。具体职责与准备时机见完整源码包的 `docs/architecture/audio-tags.md`，独立作者包只提供本合同及基础工具。

插件选择补标签时，前述大小、内容身份和 Range 都对应补标签后的最终字节；标签改变也应改变内容身份。不能沿用原文件描述到首次 `open` 才改变字节，也不能以共用工具的格式集合限制其他插件。资料获取、字段缺失和原标签处理仍由插件按来源事实决定。

插件也可在目录阶段确定最终文件布局和大小，再在首次 `open` 生成内容。此时发布的是最终表示的完整 `FileInfo`，不需要 `deferredInfo`；同一 `contentId` 的首次生成结果必须持久固定，并由全部读取复用。网易云示例选择源大小加 1MiB 的 MP3/FLAC/M4A 表示，空白区段按需输出；超预算时另存准确单曲表示并返回 `content_changed`，由刷新发布新描述，不能改变旧描述的长度。这是示例插件的策略，不是核心要求，也不强制 QQ、APE 或第三方插件采用。

## 认证与私有状态

正式认证 DTO 使用明确步骤：等待/二维码、打开链接、输入字段/验证码、成功、过期、失败；用户可取消。action 表达开始、查询、提交输入与取消，挑战状态由插件解释、由 `sources` 关联到唯一实例、操作和代际。

认证表单复用公开 Schema 和字段错误，不放入任意 React 组件；前端只获取当前交互需要的数据。来源无需认证时无需提供 authenticate，核心不能显示必填扫码页面。

`complete`表示来源已取得可用凭据；`accountName`可省略。昵称等非必要资料不应延长扫码步骤；内容所需的来源账号ID可以由插件在相应内容读取时解析并保存在私有状态。两个示例当前均在取得有效凭据后完成，资料故障作为后续内容失败独立重试。核心仍按步骤期限和操作代际拒绝真正过期或被替换的结果，不因资料查询增加新的通用认证阶段。

`waiting.qrCode` 是待编码的文字载荷，由宿主本地生成二维码；0.1.1 的可选 `qrImage` 是来源已生成的内嵌 PNG/JPEG（仅 base64 data URI，最多 350,000 字符），页面在提供图片时优先显示它。宿主拒绝远程图片 URL、SVG 和超长值；插件如需取得远程二维码图片，在插件内请求、检查类型/大小并转换。`url` 是可选的 HTTP(S) 授权页面地址。waiting/input 的 challengeId 与 expiresAt 必须有效；submit 只用于当前 input，poll 只用于当前 waiting。插件可在新步骤中更换 challengeId。管理端的 operationId 属于宿主，不进入插件 action。

交互步骤在 SQLite/D1 保存，公开投影可在页面或宿主重启后恢复。开始、完成、取消及过期终态使旧调用失效；完成前后各有一次代际推进，以清除等待期间的旧内容。取消先写入宿主状态，再向插件发送当前挑战的 cancel；只有明确 cancelled 的清理结果可提出私有状态更新，不能借清理响应重新完成授权。

插件执行获得 `privateState` 快照，通过结果中的 `nextPrivateState` 提出完整的新私有状态。`sources` 使用自己捕获的实例代际和私有状态 CAS 版本提交，而不是接受插件自报的“当前版本”。过期结果不覆盖授权；并发状态变化要核对、合并或重新调用，不能盲目 last-write-wins。

用户退出某个实例的授权时，宿主保留配置，将该实例的 `privateState` 重置为 `null` 并清除交互认证记录，推进实例代际以使旧内容缓存和在途结果失效。插件应从空私有状态重新执行现有认证流程；不需要额外的退出钩子。此操作只清除 MusicFS 保存的授权，不承诺注销来源平台的其他设备或收回已经交付的音频。

业务结果与已确认的授权变化分别处理：例如 token 已续期、随后目录请求失败，失败结果仍可携带新授权状态，经同样的代际/CAS 检查保存；`library` 仍不得发布失败目录。不能因为整个调用失败就丢弃已发生的必要状态变化，也不能因为有新状态就把失败内容当成功。

这份私有状态用于必要授权与来源流程状态，不承载整份公共目录或音频缓存。小资料和表示计划使用下述可选缓存，不直接暴露数据库或任意 SQL 能力。

### 可选小资料缓存（0.1.6）

正式宿主提供 `ctx.cache.get/put`，值为 JSON；`undefined` 表示未命中或到期，缓存的 `null` 是合法值。`expiresAt` 为 Unix 毫秒；不指定则保留至来源/插件修订失效或实例删除。键长 1—4096 字符，单条 JSON 的 UTF-8 大小至多 1 MiB，为现有 D1 的[单行限制](https://developers.cloudflare.com/d1/platform/limits/)留出余量。不要用它保存整首音频。

缓存按实例、实例代际、插件修订及安装代际隔离；配置、退出/换号及插件变更后，旧调用不能写回新来源，普通凭据续期不清除音乐资料。写入时回收该实例的过期/旧范围条目，实例删除级联删除。缓存不自动解释音乐字段或决定 TTL，插件对键和资料策略负责。

已发布文件依赖的计划应使用与内容身份绑定的不可变键，不给它短于文件引用寿命的 TTL。刷新资料得到新计划及新 `contentId`；旧引用不得偷偷读取同键下的新字节。来源不需要缓存时可不使用，也不因此必须增加补标签能力。

0.1.7 的可选 `getMany(keys)` 与输入位置对应，保留缺失值、缓存的 `null` 和重复键；正式 SQLite/D1 用一次查询取得一组键。可选 `putMany(items)` 原子写入一组 `{key,value,expiresAt?}`，保持同一来源代际、大小和到期合同。旧宿主可回退 `get/put`，但不获得相同的往返成本；调用者不应假定任意大的批次都适合单次调用。清理在一次插件调用的首次写入执行，用到期和来源范围索引定位旧行，不逐文件扫描所有有效资料。

0.1.9 的可选 `putIfAbsent(key, value)` 在同一来源范围内原子写入无到期值，并返回最终保留的 JSON；键已有有效值时返回原值，包括合法的 `null`。缺失或已到期时才能写入候选值。SQLite 事务与 D1 batch 将条件插入和读取获胜值放在同一持久操作中，延迟生成者必须使用返回值，不能假定自己计算的候选一定获胜。它沿用代际、取消、键长和 1MiB JSON 限制；没有该能力时不能用普通 `get` 后 `put` 模拟原子固定。网易云用它固定首次读取计划，另有带 TTL 的小 ready 索引供未来刷新复用；ready 到期不删除该文件版本的永久计划。

可选 `Context.workBudget.remaining` 是宿主实时核算的本次剩余工作提示，插件可据此在下一项工作前保存分页游标；它不承诺某个账号的实际平台配额，也不要求插件识别桌面、Worker或收费方案。正式 Worker 分开核算外部请求和缓存查询，给外围来源检查/检查点留出余量；桌面未提供时插件使用自身耗时与处理量边界。两个宿主可复用同一个自适应分页算法，不能由宿主名称直接推导“一页只能几首”。

可选 `Page.progress = {completed,total,unit}` 表达本目录扫描的累计工作进度，例如处理曲目而非导出文件。它与增量 `statistics` 分开：同一扫描的总量/单位稳定，完成数单调且不超过总量；核心保存并投影，不解释音乐含义。限流等待时已接受页面及进度保留，不能将未完成的一页计入。

## 按需会话续期

0.1.5 的 `renewal` 是可选能力，不要求来源具备账号。`needed` 只检查当前私有状态与本地时间；来源有效期、提前量和重试策略仍归插件。`sources` 在 roots/list/stat/open 前调用它，配置检查与交互认证走原合同。返回 false 或未声明能力时不取得续期租约，普通内容操作保持并发。

确需续期时，宿主按实例在 SQLite/D1 条件取得短租约，同时预留一个私有状态修订；网络请求在事务外执行。预留修订及普通写入检查防止旧调用的完整状态覆盖新凭据。完成时原子保存可选新状态、公开错误与短期重试时间，并释放租约；其他控制器等待后读取新状态或复用该次失败，不依赖 Worker isolate 内存。配置、交互认证或插件代际变化使旧续期不能提交。续期不改变实例代际，不作换号处理，也不使成功目录失效。

当前租约60秒、续期操作信号25秒、等待预算25秒；等待可取消，取消一个等待者不取消另一调用的续期。插件应把信号传到真实 Fetch，不以租约替代取消。已发生的凭据变化由 `renew` 的 `nextPrivateState` 独立提交，之后内容读取失败也不会丢失。插件可把成功检查/临时失败的下次检查时间保存在私有状态；核心不解释 token、有效期或登录渠道，也不增加定时登录。

## 配置与私有状态迁移

`configVersion`、`stateVersion` 分别描述配置和私有状态的数据结构版本，与插件包的 SemVer 区分。只有对应结构版本变化才调用其转换：`migrateConfig` 接收旧配置/旧状态，`migrateState` 接收旧状态和已转换配置。转换为同步纯函数，返回完整 JSON 候选；不执行 I/O、修改当前持久数据或启动后台任务。

有受影响实例的结构升级必须提供相应转换函数和 `validateState`。宿主复制并校验 JSON，先检查目标状态，再以候选配置/状态调用可取消的 `validateConfig`，接受其规范化配置及可选 `nextPrivateState`，最后再次验证目标状态。任何一步拒绝、抛错或返回非 JSON 都使整个更新失败。结构版本不变的兼容更新不运行这些钩子，也不强制已有插件新增它们；没有实例时无需转换数据。

安装用例一次冻结当前实例集合及每个实例的配置、状态、代际和状态修订，逐实例保存候选。最后在同一个 SQLite 事务或 D1 batch 中，条件切换安装记录、**全部**实例候选及操作终态；任何实例被新增、删除、配置/授权变化或安装代际改变，均拒绝整体切换。成功后实例 ID、名称和布局保留，实例代际/状态修订递增并清除旧交互认证记录；旧请求及旧目录快照不能写回。

桌面端先加载不可变候选修订，后台可跨重启继续。Worker 先冻结输入再发布包含新旧代码的集合；核对上传成功后，必须由确实包含目标 `(pluginId, revision)` 模块的后续调用执行迁移与激活，旧调用不会拿旧模块迁移。失败保留旧安装和全部活动数据；终态清理暂存候选，不提供任意回滚图或跨代码发布/数据库的事务。

## 错误与生命周期

标准错误 kind 供核心选择通用响应和重试，来源可提供不含秘密的具体说明。`needs_auth` 与 DAV 密码错误区分，`unavailable` 与网络/解析错误区分，`not_found` 与未完成刷新区分。音质缺失是否隐藏或回退在插件内处理，不新增核心全局错误策略。

意外异常由调用 seam 转换为诊断失败；正常空目录、明确的来源不存在和临时故障不可相互混用。核心只在有证据的范围有限重试，并与 SDK/平台库的重试配合，避免多层相乘。

每次调用由宿主绑定到实际已加载插件修订和实例代际。更新/移除后旧任务不能写回状态或发布目录；取消信号使慢操作尽快结束。普通数据状态不可依赖插件全局变量；Worker isolate 重建或桌面重启后从实例持久状态恢复。

## 验证插件行为

- 独立最小插件仅引用公开类型，声明普通配置，提供一个目录和固定字节文件；同包两实例独立工作。
- 前端表单与作者生成的后端结构校验使用同一 Schema，复杂字段、默认值与错误路径一致，Worker 不动态生成校验代码。
- 内容分页、重复出现、中文/重名路径、未知大小、明确无权限和临时错误得到各自结果，不发布截断快照。
- Range、上游忽略 Range、内容换版、流截断、取消及背压经过真正的 `library`/DAV 接线验证。
- 换配置、换号、认证取消、更新、移除与实例删除后，旧调用结果均不能改变新状态。
- Bun 编译产物外置加载与真实 Worker 注册/部署分别验证；接口类型兼容不替代运行验证。
