# 网易云音乐示例插件

插件标识为 `org.musicfs.netease`，版本和宿主兼容范围见 [manifest.json](manifest.json)。它使用公开插件合同，来源协议和资料补全由插件负责。

## 构建与使用

```sh
bun run build:netease
```

产物为 `dist/netease/org.musicfs.netease.zip`，在管理页安装后添加来源并用网易云音乐 App 扫码。提供喜欢的音乐、每日推荐、自建/收藏歌单和推荐歌单。歌单以完整成员名单为准，保留顺序和重复位置。

音质按实例配置：标准、极高、无损、Hi-Res，可选择单版本、多版本以及隐藏或向下回退。文件名与格式使用实际取得的版本；同一曲目位置的相同实际文件只导出一次，试听不作为完整音频。

## SDK 与请求

固定使用 `NeteaseCloudMusicApi` 4.32.0，构建时选择必要模块和原有加密实现，注入宿主 Fetch、取消信号及独立 CookieJar，无需另起 API 服务。适配入口见[构建脚本](../../scripts/build-netease.ts)。

歌单扫描在开始和完成前核对成员名单，详情与播放版本按200首批量读取，只补缓存缺失项。确认后的 Cookie 按实例持久保存；明确失效时重新授权，普通资料或网络失败不清空有效会话。

## 按需标签与文件合同

MP3、FLAC、M4A 提前公布准确预留表示，目录和 HEAD 不逐曲获取歌词、封面或音频结构，首次 GET 才准备所读文件。标签工具复用原音频区段，按需生成合法填充；文件大小及特殊布局限制见[兼容性说明](../../docs/verification.md)。

`reference.ts` 定义原表示身份，`metadata.ts` 映射来源资料，`tagged.ts` 保存表示计划和输出引用。资料缓存、固定文件计划和临时播放地址分别处理；首次计划原子保存，已发布引用保持相同字节。保留来源已有的多位歌手、封面、歌词时间轴、译文和罗马音，缺失字段不猜测。

## 验证与开发

离线批量检查使用 `bun scripts/probes/netease-refresh-offline.ts`。真实二维码或已有会话复测使用 `bun run probe:worker:netease`，会访问来源平台；配置方式见[开发检查](../../docs/development-reference.md)。

第三方插件可以透传原文件或自行补标签，示例的音质、歌单及按需策略不是所有插件的必选要求。公开合同见[作者指南](../../docs/plugin-authoring.md)。示例自有代码采用 GPL-3.0-only，发布包保留依赖各自的第三方许可和署名。
