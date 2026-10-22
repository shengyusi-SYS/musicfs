# 自动更新与命名模板：离线集成核对

2026-10-23，源码候选 `0.1.0-dev.23`、插件 API `0.1.11`，网易云 `alpha.20`、QQ `alpha.19`。现行行为见[架构](../architecture/updates-and-naming.md)，本页只记录证据范围。

## dev.24 规则编辑修正

重复创建和修改到已有范围返回 `update_rule_exists` 及已有规则 ID，不再误报为来源状态变化，也不会隐式改写原规则。`refresh-schedules.test.ts` 的 SQLite、D1 与管理接口共16项通过，包括两条规则的范围和时间均保持不变。

界面按来源与范围载入已有时间和启停状态；没有规则时才创建。已移除重复范围警告、跳转按钮及额外规则选择框，范围切换不搬移原规则。三套 TypeScript 检查、WebUI 构建和依赖边界检查通过；界面证据为代码核对与构建，未新增浏览器或 Windows 运行验收。

## dev.23 核对结果

| 路径 | 证据与结果 |
|---|---|
| 时间与范围 | `update-timing.test.ts`、`refresh-schedules.test.ts`：时区、每天/每周、间隔完成后计时、错过安排、全实例新目录、递归与循环、部分失败、重叠工作复用、无关活动任务竞态均通过 |
| 双存储 | 调度及命名使用真实 SQLite 与本地 Miniflare D1；重开控制器后规则、设置、继承和原发布内容保留 |
| 迁移 | 版本1—9原数据向当前schema14迁移并重开；旧schema10周期规则保持原范围与首次待执行时间 |
| 命名与读取 | `file-naming.test.ts`、`file-naming-integration.test.ts`：条件块、真实扩展名、同名/重复项、前部插入与换序、目录覆盖与恢复继承；预览和DAV实际路径相同，Range字节及ETag保持正确 |
| 缓存身份 | 命名应用不改变源epoch、快照ID、fileRef或最终表示，不增加来源list/stat；暖索引通过已有4,000项HEAD/GET/Range用例，其他控制器可观察配置变更 |
| 桌面装配 | `desktop-refresh-policy.test.ts`：没有网页也可推进规则；无变化更新不通知挂载；改名只通知对应可见目录，相同设置再次应用不重复通知 |
| 示例插件 | 网易云、QQ离线清单用例断言命名资料来自原歌曲信息；NetEase换序后的稳定命名身份不跟随全歌单位置变化 |
| 界面与构建 | 三套TypeScript检查、WebUI构建、Worker浏览器目标打包、sample/QQ/NetEase插件构建通过；依赖方向检查294模块、1233依赖无违规 |

集中执行受影响的13个测试文件共112项。首次109项通过，3项仍断言整实例跳过新目录的旧合同；按本轮已确认的完整范围更新这些断言后，该文件9项全部通过。随后扩充桌面同一用例，核对真实装配的改名通知和不变快照，也通过。没有为纯文档修改再次重跑全部用例。

主要测试入口：

- [时间计算](../../tests/update-timing.test.ts)、[调度与持久关联](../../tests/refresh-schedules.test.ts)、[完整实例范围](../../tests/instance-refresh.test.ts)
- [命名核心](../../tests/file-naming.test.ts)、[SQLite/D1与HTTP/DAV集成](../../tests/file-naming-integration.test.ts)、[桌面装配](../../tests/desktop-refresh-policy.test.ts)
- [暖视图复用](../../tests/library-views.test.ts)、[持久发布](../../tests/refresh-persistence.test.ts)、[原数据迁移](../../tests/migrations.test.ts)

这轮没有请求真实音乐平台、部署Cloudflare、调用Windows宿主或重跑VM。界面证据是代码核对与构建，不记为浏览器点击或原生播放器验收；本地D1和Worker打包不替代免费计划CPU或真实云端证据。后续已集中生成dev.23的Windows、离线Worker、源码与作者包；身份、文件摘要及下载入口见[发行页](../release.md)，不新增目标系统运行结论。
