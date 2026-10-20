# Worker真实云端首部署

日期：2026-10-20。环境：WSL2、Wrangler4.119.0，用户提供的付费Cloudflare账号。本轮只部署一个独立Worker和一个D1，关闭Cron及持久日志，设置100ms单次请求CPU上限；不做压测或批量音乐读取。没有调用Windows宿主。

## 资源与输入

- Worker：`musicfs-test`；入口为`https://musicfs-test.example.invalid`。
- D1：同名数据库，ID为`<resource-id>`；七份既有迁移全部成功。
- 实际版本：`<resource-id>`，平台报告启动时间57ms。
- 构建基线：`4c75502`，dirty=false；源码输入摘要`3d05e50b6d339e8c1eb3eda08dd992d650f3809cbc40dea390361601c9bddffe`，页面摘要`6f7207f074522e2255b92229079ba9d08d977803d2f5a87b702a3f6bebc9a383`。应用0.1.0-dev.0、API0.1.5、schema7，初始插件集为空。
- 使用现有`buildWorker`入口生成`dist/cloud-acceptance/`，不重建页面或桌面。测试配置、资源身份和私有凭据仅保存在忽略的`.musicfs/cloud-acceptance/`；未将本机Wrangler的OAuth凭据上传到云端。

首次部署通过Wrangler的`--secrets-file`一次设置ADMIN_TOKEN及DAV_USERNAME/DAV_PASSWORD。用户询问发布Token的必要性后，先解释取舍，再由用户提供专用Token；没有以本机短期OAuth令牌代替长期独立运行配置。

## 有限结果

| 实际请求 | 结果 |
|---|---|
| 共用WebUI及其入口JS | 均200，页面有React根节点 |
| 正式管理status | 200，宿主为worker |
| 初始插件列表 | 200，空安装集 |
| 读取凭据访问DAV根 | PROPFIND 207 |
| 相同读取凭据访问管理插件列表 | 400及Bearer认证挑战，未获得管理访问 |

共7次HTTP请求。首个检查程序已通过前五项，最后误把Basic访问Bearer入口的预期固定为401；Hono对此返回400，符合现有中间件规则。仅补查最后这一请求，没有改鉴权产品代码或重跑前面五项。原始有限结果保存在本机忽略目录的`initial-checks.json`。

## 实际打包冗余修正

首次Wrangler上传把WebUI JS、迁移SQL和一份许可文本也当成了Worker模块，代码上传量2,661.49KiB、gzip778.21KiB。它们已有独立静态资源/迁移/发行材料入口，不需要再作为运行模块上传。

已收窄模板ESModule规则到根mjs及plugins下的JS/mjs，并关闭ESModule/Text规则的fallthrough，避免再次合并默认扫描规则。[官方规则说明](https://developers.cloudflare.com/workers/wrangler/configuration/#bundling)

相同空插件产物经Wrangler本地dry-run只附加core/registry，加主入口共3模块，代码929.06KiB、gzip221.11KiB；静态资源仍单独识别25个文件。修正已随必要的Token配置合并部署生效，版本`<resource-id>`，启动62ms；静态资源无需重传。没有为包体减法单独重发，也没有新增依赖、数据库迁移或运行时机制。

## 插件自动发布与数据保留

专用Token通过相同secrets-file写入CF_API_TOKEN后，正式管理API上传现有sample0.1.3 ZIP。返回202，约6秒后completed；只用了POST和两次查询，共3次管理请求。Worker自行经Content API发布模块、核对代码后激活D1安装，无Wrangler代发或数据库手工激活。

随后在同一Worker/D1执行一个有限旅程，47次应用请求和3次直接控制面读取，不增加测试资源：

| 行为 | 真实结果 |
|---|---|
| 同插件双实例 | 各有独立ID/config/内容源名称；自定义布局保存后可读 |
| 已知WAV | HEAD 16,044字节，全文RIFF及64字节尾范围206与全文对应字节相同 |
| 一次更新失败 | 仅把预构建sample入口加初始化异常，版本0.1.4-failure；Cloudflare拒绝发布，操作failed/deployment_failed，旧实例、配置、布局及HEAD仍保持 |
| 正常更新 | 同一原包只改manifest为验收版本0.1.4，操作completed；原实例ID/config和布局保留 |
| 移除/重装 | 移除后实例与布局保留，原DAV读取503；重装同一0.1.4验收包后恢复HEAD 16,044 |
| 独立删除 | 仅删除第二实例，第一实例保留 |
| 配置保留 | SDK直接读取平台设置，对比前后bindings、compatibility、limits和observability完全一致；DB ID不变，四个Secret和ASSETS绑定保留；后续发布实际继续使用CF_API_TOKEN，管理/DAV凭据继续有效 |
| 静态资源/费用边界 | WebUI入口JS与本地发行物SHA-256一致；平台Cron列表仍为空，CPU上限仍100ms |

0.1.4和0.1.4-failure均为此旅程的临时预构建验收包，不是新的sample正式发行；仓库及独立发行ZIP仍为0.1.3。更新使用原插件代码/Schema/许可，不新造来源实现。原始有限结果与操作记录保存在本机忽略目录的lifecycle-result.json、lifecycle-changes.json和lifecycle-trace.json。含绑定值或凭据的原始平台响应不进入记录。

## 两个真实示例就绪

同一正式管理入口继续安装现有QQ alpha.10及网易云alpha.8，分别仅POST加一次查询，共4次应用请求，均completed；没有新建Worker或D1，也没有重编译示例。随后各创建一个独立实例，QQ选择已有微信通道，网易云沿用单版本默认设置；仅2次创建请求。

已准备本机私有管理链接文件`.musicfs/cloud-acceptance/admin-url.txt`，请用户手动打开网页完成这两个实例的扫码。没有自动打开宿主浏览器，也没有主动启动会过期的二维码后反复轮询。真实授权、来源内容和音频读取继续待验。

首次配置说明同步收敛为一次`wrangler deploy --secrets-file`写入四项Secrets；无需每项Secret各发一次更新，也不增加另一套云端OAuth续期机制。

## 下一步与方案边界

下一项是示例插件的真实云端认证和代表性读取。上述结果已证明普通Worker的后台插件发布及绑定/状态保留；尚不证明示例来源、任意在途读取切换、响应丢失恢复、云端大目录资源或免费计划已通过。不扩展为全组合故障或媒体矩阵。

Wrangler登录只给本机部署工具授权。现有普通Worker方案让云端在插件变更时重发代码，因此需要一次配置长期发布Token；它不是每次安装都重新申请，也不是日常DAV读取的前置条件。

Cloudflare原生Dynamic Workers是替代候选：Worker Loader绑定可加载预构建模块，能够消除自行发布和发布Token，但需改变Worker宿主中的插件调用/状态与流接线。它当前只支持Workers Paid，并有按日创建量、请求和CPU计费；同一代码应使用稳定ID复用。[原生加载](https://developers.cloudflare.com/dynamic-workers/getting-started/)、[价格](https://developers.cloudflare.com/dynamic-workers/pricing/)

本轮没有启用这一候选，也没有改变免费优先的既有范围。不同时维护第二套插件运行机制；先说明一次性配置与长期产品取舍，再决定是否调整路线。
