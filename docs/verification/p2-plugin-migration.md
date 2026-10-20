# 插件结构升级与整体激活

日期：2026-10-20。环境：Linux x86_64、Bun1.4.3、Nodev24.19.0；公开合同0.1.4-dev.0，数据库schema6。范围为已确认的插件更新/失败保留；真实Cloudflare部署传播、免费配额与来源会话续期分别待验。

## 实现与责任

- [extensions](../../src/core/extensions/index.ts)解释清单、SemVer/宿主兼容和同版本内容冲突。旧兼容安装辅助入口仍拒绝直接切换结构版本，防止绕过整体迁移。
- [sources迁移](../../src/core/sources/migration.ts)复制JSON，按实际变化调用migrateConfig/migrateState，验证目标状态，以候选上下文执行可取消validateConfig，再验证规范化配置/状态。转换过程不写活动数据，不解释来源字段。
- [共用用例](../../src/application/change-plugin.ts)拥有操作、一次输入冻结、逐实例候选与整体激活次序。[共同SQL](../../src/infrastructure/persistence/plugin-change-sql.ts)由SQLite事务/D1 batch执行，不跨网络持锁。
- [桌面控制器](../../src/hosts/desktop/changes.ts)先准备不可变ESM修订。结构升级返回202，使用原目录刷新后台循环继续/重启恢复；兼容更新仍立即201。
- [Worker控制器](../../src/hosts/worker/changes.ts)冻结输入后发布含新旧代码的集合。代码核对成功后，只有含精确候选模块的后续调用能迁移，每次至多一个实例，另一步才激活。无页面时现有scheduled入口可继续，不在waitUntil递归循环。

最终条件同时核对安装代际、完整实例集合（包括新增/删除）及每个实例epoch/stateRevision。全部匹配才同次切换安装、所有配置/私有状态、递增实例代际/状态修订、清认证记录并完成操作；终态在同事务清候选行与Worker暂存块。失败保持原安装和全部活动数据；旧请求仍受已有来源戳/CAS约束。

没有新增依赖、通用任务平台、ORM或回滚图。JSON复用Zod，包/版本继续zip.js/semver，发布继续官方SDK。迁移顺序、实例冻结和原子激活是本项目领域规则，不另找库代替这些规则。

## 自动化证据

```sh
bun test tests/plugin-migration-source.test.ts tests/plugin-change-persistence.test.ts tests/plugin-migration-desktop.test.ts tests/worker-publishing.test.ts tests/migrations.test.ts
bun run check
bun run build:web
```

| 范围 | 结果 | 具体覆盖 |
|---|---:|---|
| 候选转换/验证 | 5项 / 57断言 | 配置先于状态转换、validateState前后核对、规范化/续期候选、输入隔离、取消到真实Fetch；仅变化的schema要求转换 |
| 两驱动持久化与数据库升级 | 17项 / 235断言 | 真实SQLite/Miniflare D1，重启后候选仍在；完整集合/状态/代际冲突、零实例不重选、租约接管、旧目标已激活不二次增代；schema1—5数据及旧Worker检查点迁至6并重开保留 |
| 正式桌面HTTP/真实外置ESM | 3项 / 29断言 | 两实例整体升级；旧HEAD在升级后返回503且旧私有状态不写回；转换失败全部保留；后台重启后等遗留租约到期自动续跑，无管理GET推动也完成；ID/布局与Range可读性保留 |
| Worker发布与迁移接棒 | 6项 / 207断言 | 官方SDK+真实本地D1，平台网络受控；旧控制器无精确候选时不迁移/激活，新调用逐实例后原子切换；失败保留旧可执行修订和全部实例；响应丢失只PUT一次；半包暂存不发布，中断后失败清理 |

完整检查为 **179 pass、0 fail、2,173次断言**；三组TypeScript、**144模块/489依赖**边界通过。新增跨领域用例禁止导入宿主/传输/基础设施/前端或原生运行时。页面构建通过，原有约558kB Schema分块提示保留。

恢复审阅又复现遗留租约问题：重启时首次扫描无可领取操作，租约到期后仍不再唤醒。桌面SQLite现在复用两类操作的就绪/来源有效性条件，读取最早持久租约到期时间；同一个后台循环只在确有后续工作时设一次可取消唤醒，不做固定频率空轮询。回归在启动前持久化一条120ms遗留租约，修复前5秒未完成，修复后约150ms完成且没有管理GET；结束后无后续工作时间。它没有杀死真实迁移进程，实际SIGKILL/锁恢复仍查桌面宿主记录。最终完整检查包括此修复；页面查询失效、0.1.4夹具、表单及正式workerd另有定向验证。

## 浏览器与原生发行物

使用隔离临时桌面服务和真实v1/v2 ZIP，不操作开发账号或布局。在共用页面先查看v1配置，再从发布地址更新：显示“准备升级”，重复安装/移除禁用；刷新后回到插件页恢复查询并显示2.0.0可用。两个实例ID保留，配置表单改为title/endpoint新字段且原值保留；无新增warn/error。仅检查现有950×1006浏览器视口，没有扩展为响应式或跨浏览器验收。截图保存为本次本机临时证据 `/tmp/musicfs-migration-config.png`。

本轮只重建Linux原生发行物与Worker包。Linux二进制SHA-256：`0ce7c779061d239085c9251b7ee6df30b0f0d9f91d93854ecbe1a8f337524e27`。`bun scripts/probe-desktop-product.ts`从发行物验证分离后台、页面、sample外置安装、16,044字节HEAD、RIFF范围、重复启动/凭据复用、挂载入口及正常退出；本轮未重复系统挂载。

另从该二进制的正式HTTP入口安装本记录桌面夹具：v1返回201，创建两实例，v2返回202，后台完成后两实例ID相同、配置变为title/endpoint、epoch为2。只用临时数据，正常退出并清理。该结果补充源码测试，未声称在Windows/macOS验证；其他桌面目标仍是此前构建检查点。

Worker构建含正式core/registry、三个现有插件、共用页面及六份迁移；`bun scripts/probe-worker-service.ts`已在schema6下通过正式页面/API/DAV、D1重启、缺凭据诊断及坏插件初始化拒绝；该探针使用sample夹具后，已重新生成含三个插件的正式Worker包。此结果和迁移测试与云端验收分开。部署时先应用至0006.sql，不能用旧schema代替。没有Cloudflare测试账号，因此真实新旧isolate交接、配置保留、在途流影响、规模与免费资源表现仍待验。

开发服务8787已更新到最终代码。先保留私有SQLite备份，再由正式启动路径把schema5迁到6；4条安装、6个实例（含配置/私有状态/认证记录）及布局的逐行摘要与升级前完全相同。备份和原始数据不进入Git。

## 下一项

继续双示例会话续期、失效重登及必要取消路径，再处理Worker剩余CPU与真实环境交付。迁移接口及受控测试不证明网易云/QQ已具备全部续期能力；不为缺失真实格式样本扩建全局音乐模型。
