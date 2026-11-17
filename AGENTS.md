# HGhubX 工程入口

这份文件给修改仓库的工程师和 coding agent 用。它不是产品说明，也不重复 README。
用中文沟通，修改和打包前先核对代码及实际运行版本。当前同步基线：上游 2.2.0、
`5f60e371a63798ff17bef18e87cc2e6453d5a24d`（2026-11-18）。当前目录与依赖边界见
[`docs/architecture.md`](docs/architecture.md)；实际文件以工作区为准，不要凭旧路径猜文件。

## 合并源仓库的默认要求

以下是用户于 2026-11-18 明确设定的长期约定。以后用户要求“合并/同步源仓库提交”时，
默认执行本节；源仓库为 `zxsos/HGhubX`，目标 fork 为 `michaelxiao0304/hghubx`，执行前仍须
核对实际 remote、分支和提交。用户当次明确调整的范围优先；合并上游文档时也必须保留这些约定。

1. **保护目标仓库的全部改动。** 合并前盘点 fork 相对上游的提交、行为差异及未提交改动，
   保护范围不限于下面列举的网络兼容、数据迁移、401、播放修复和文档。只有确认上游也解决了
   同一问题、覆盖 fork 原有行为与边界条件，并通过对应回归后，才可用上游实现替换本地修复；
   在交付记录中说明替换依据。不能因为同文件冲突、上游版本较新或目录重构就整文件覆盖。
2. **解决冲突并验证功能不回退。** 按行为逐项合并，保留双方有效改动；确保收藏、观看记录
   （含集数和秒数）及原有功能不受损。运行现有自动化测试、构建检查及受影响功能的回归，
   尤其核对存储迁移、401/账号隔离、网络兼容、旋转和断点续播。所有应执行的检查通过后才进入
   交付打包；不删测试、不放宽断言来获得通过。新增用例仍遵守下文的维护者同意要求。
   如检查受环境限制无法执行，明确报告未验证范围，不能将跳过当作通过或宣称全部完成。
3. **高风险操作先确认。** 对可能丢失数据或改动、重写共享历史、影响凭据/签名身份或公开发布
   的操作，先说明具体动作、影响范围及备份/回退方案，获得用户明确确认后再执行。包括丢弃
   未提交改动、破坏性重置/清理、强推、删除应用数据或迁移备份、撤销/替换证书、推送发布标签
   或发布 Release。只暂停依赖该操作的步骤，其他已授权的低风险工作继续；常规合并、修冲突、
   测试及使用现有环境打包按本节执行，无需反复确认。
4. **测试通过后交付两端安装包，不安装。** 实际构建 Universal DMG（arm64 + x86_64）和 iOS
   IPA，按下文核验最终产物的版本、架构、完整性及签名/描述文件，报告路径、源码提交和验证结果。
   两端均成功才算打包完成，不用旧产物代替本次构建。默认不覆盖本机 App、不向手机安装，
   即使手机已连接也不安装；历史任务的安装授权不沿用，安装须用户另行明确要求。

## 先读什么

1. [`docs/subsystems/README.md`](docs/subsystems/README.md)：找到你要改的子系统。
2. 对应子系统页：责任边界、事实来源、运行时路径、状态转换、失败行为、验证命令。
3. [`docs/code-standards.md`](docs/code-standards.md)：本仓库的评审规则。
4. [`docs/lessons.md`](docs/lessons.md)：已经造成过回归、以后必须检查的教训。

只改一个面板、一个缓存或一条播放路径时，仍然先读它所在子系统的整页。不要从
组件文件名推断契约；以页面列出的 Rust 命令、前端 key 和状态检查为准。

## 命令

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:smoke
cargo test --manifest-path src-tauri/Cargo.toml --lib
make check
```

- `pnpm build` 执行两份 TypeScript 检查和 Vite 构建。
- `pnpm test:smoke` 运行不需要 ffmpeg、真实 Tauri 宿主或上游网络的稳定浏览器用例。
- `make check` 当前执行 `test-rust`、`test-web`、`docs`、`budget`；**不包含** `test:smoke`。
- `make release-check` 检查版本字段和 Android `versionCode`；发版由 CI 执行，不在本地发布。
- 完整播放回归用 `pnpm test:playback`；它需要 FFmpeg 和 Chromium，属于手动诊断而非 PR smoke。

CI 是验证记录。命令写了不等于已经运行；报告里必须写清命令、输入、字面结果和退出状态。

## 一屏架构

### 前端

- `src/main.tsx`：挂载 React、启动诊断，并在使用协议确认后装配应用 Provider 和自动选线。
- `src/app/`：`App.tsx` 负责页面栈、桌面/移动布局和全局交互；`shell/` 放窗口控件，
  `startup/` 放启动门。
- `src/features/`：按 `account/category/discover/feed/playback/posts/search/settings` 归组页面、
  专属组件与 hooks。Feed 的详情/评论/选集面板、设置页的线路/代理控件都随功能放置。
- `src/shared/`：`api`（IPC 与响应类型）、`model`（应用/账号/内容偏好状态）、`network`（自动选线）、
  `storage`（存储键与协议版本）、`diagnostics`、`lib`、`ui`（跨功能控件）。
- `src/shared/model/store.tsx` 仍聚合导航、账号与播放偏好；这次目录迁移没有拆 Provider。
  `shared/ui` 可消费 `shared/model`，不是独立的无状态控件库。
- 依赖以 `app → features/shared`、`features → shared` 为主；现有 `feed/posts → playback`、
  列表页 → `search/InplaceSearch` 是明确的功能复用。`shared` 不反向依赖 `app/features`。
- 页面懒加载直接指向功能内的页面文件；不要新增汇总全部页面的 barrel。`src/index.css` 与
  `src/styles/` 保持固定位置，避免目录整理改变样式加载次序。

### Rust

- `src-tauri/src/api/`：Tauri command 与上游 endpoint，按 account/feed/video/interact/update/platform/lines 分文件。
- `src-tauri/src/net/`：`line`（线路状态）、`proxy_env`、`client`（客户端缓存/DNS/GET）、
  `redact`、`diagnostics`、`edge`（信封/重试/字节下载）；共享 statics 和测试在 `mod.rs`/`tests.rs`。
- `src-tauri/src/media/`：图片、HLS、分片、Range、响应整形和本地媒体协议入口。
- `src-tauri/src/lines/`：`mirror`、`jsparse`、`probe` 三块，负责固定/发布镜像/自定义线路、
  JS-as-data 解析、探测与自动选线。
- `src-tauri/src/ios_layout.rs`、`ios_media_http.rs`、`linux_http.rs`、`linux_webview.rs`、
  `macos_titlebar.rs`：按 `cfg` 编译的平台壳；Windows/Android 的壳逻辑部分在 `lib.rs` 与前端。
- `src-tauri/src/session.rs`、`cache.rs`、`env.rs`、`playback_log.rs`、`network_policy.rs`：
  当前的 state/安全基础设施；逻辑上归 `state`，物理上尚未收进目录。
- `src-tauri/src/lib.rs`：只做插件、状态、窗口、协议和 `generate_handler!` wiring。

依赖方向：`api` 可依赖 `net/lines`，`media/platform` 可依赖 `net`；`net/media/lines` 不依赖
`api`，也不依赖 Tauri command 名。平台差异放在 `cfg` 模块，不要扩散到业务函数。

## 不可协商的不变量

1. **未知不是空。** `favoritesKnown=false` 表示收藏状态未知；读取失败不得显示“还没有收藏”。
2. **作用域和代次进 key。** 详情、播放、动作和标签门至少包含 `accountScope`、`lineEpoch`；
   播放器还要有 `permissionKey`/`playKey`。旧账号、旧线路或旧标签代次的结果必须丢弃。
3. **凭据绑定 origin 和会话代次。** `SessionStore` 只把 token 交给同一 `origin` 和同一 revision；
   切线路、退出或重新登录后，旧异步任务不能写回新会话。
4. **播放恢复有上限。** 每个连续故障期最多 4 次 HLS 恢复；只处理 fatal network/media；
   `MANIFEST_LOAD_ERROR`/`MANIFEST_LOAD_TIMEOUT` 用 `loadSource`，其他用 `startLoad(time)`；
   页面被覆盖时不发恢复请求；保留播放时间、倍速和显式暂停意图。
5. **媒体只走本地路由。** 前端只把 `/img`、`/hls`、`/seg` 交给本地协议；iOS AVFoundation
   只使用 `media_http_origin()` 启动的 capability loopback；Linux GStreamer 只使用
   `127.0.0.1:17650`。不得把这些路由扩成通用开放代理或任意路径转发。
6. **安全模式默认开启。** 外部 URL 要经过 scheme/主机/IP 检查、DNS 固定和逐跳重定向检查；
   禁止 HTTPS 降级和普通内网/回环目标（FakeIP 例外）；不得为新功能放宽 CSP、Origin 白名单或
   `trusted_auth_origin`。
7. **存储先写新键，再清旧键。** 运行期只写 `hghubx_*`；`hghub_*`、`hg.autoLine` 只在旧值已成功
   写入新键后删除。写入失败保留旧数据；清缓存不得删除登录、收藏、观看记录或偏好。
8. **Tauri 接口是契约。** command 名、参数名和 JSON 形状不能随纯移动改变；Serde 的
   `camelCase` 字段与前端类型必须同步。移动 handler 后先改 `lib.rs` 的 `generate_handler!`。
9. **一次只做一个目标。** 纯移动和行为修复分开；修复必须有在旧代码上失败的回归；测试不访问
   上游网络，fixture 要接近真实响应；尺寸预算只能在搬走关注点后下调。
10. **日志不含秘密。** 不记录 token、Cookie、代理认证、播放直链、查询参数或密钥内容；
    错误链由 `err_text`/`redact_error_proxy_auth` 脱敏，诊断只输出协议/主机/端口和固定资源编号。
11. **新增测试必须先经维护者同意。** 任何新增测试文件、场景或用例，先向维护者说明
    它验证什么、为什么现有测试覆盖不了，得到明确同意后才能加入。既有测试的断言适配
    （契约变化导致的 fixture/断言更新）不算新增，但不得借适配削弱覆盖。测试体系保持
    最精简：一个契约一个回归，不重复建同义用例。

## 变更协议

1. 在对应子系统页确认责任边界和事实来源；不确定的写成“待核实”，不要写进不变量。
2. 先决定这是纯移动还是行为变更。纯移动只改路径/import/注册，Tauri 名称和 JSON 不变。
3. 行为变更先加能在旧代码上失败的测试，再做最小修复；同时更新 owning subsystem 页。
4. 回归补一行 `docs/lessons.md`，并指向实际测试或代码路径；不要编造 issue/PR 编号。
5. 运行与改动风险匹配的命令，记录字面输出和退出状态；不把“看过代码”写成“测试通过”。
6. 一个 PR 只解决一个目标。发版、签名和 Release 由维护者/CI 执行，agent 不自行 tag 或发布。

## Fork 必须保留的约定

- 界面、业务接口、播放器、动态选线及 TV 实现吸收上游更新，同时遵守上文“合并源仓库的默认要求”；保留 fork 的全部有效改动，包括 NAT64 网络兼容、旧数据迁移、401 登录失效处理、旋转/断点续播修复及迭代文档。上游已等效解决的问题按该节验证后可采用上游实现。
- `src-tauri/src/network_policy.rs` 对 `64:ff9b::/96` 按内嵌 IPv4 判定，允许公网，仍拒绝内网与回环；不关闭 SSRF、重定向或来源隔离。
- `src-tauri/src/source_migration.rs` 在 `lib.rs` 启动恢复线路之前仅将有效旧 `source.json` 导入缺失的 `line.json`；保留原文件，不迁移跨 origin 的凭据。
- `src/shared/storage/storage.ts` 合并 fork 的 `app_data_v1:default:library` 与上游/旧版 library，收藏去重、同视频取最新观看时间并保留集数/秒数/总时长。备份 `hghubx_library_backup_v2` 和 `_libraryMigration:2` 防止重复导入，原始 library 键保留。写失败不能覆盖原值。
- `src/shared/api/authFailure.ts`、`src/shared/model/accountData.ts` 和 `src/features/account/SessionNotice.tsx` 保留 401 提示、暂停账号同步、本地续记进度、旧代次响应隔离和关闭提示。403 不视为 401。关闭提示不伪造登录恢复；仅成功重新登录恢复同步，游客数据与账号片库分开。
- 可信线路保留会话以原生 `app_boot` 为准；普通登录即使 user ID 相同也不能擅自跨站合并。账号缓存别名仅在确认 rebase 后生成，合并保留最新进度和待上传记录，原桶留作快照；回切读取别名对应的新值，不能恢复已取消的收藏或已清空的历史。可信切线不清除已确认的 `authExpired`。
- `pnpm test:storage-migration` 与 `pnpm test:session-expiry` 是 fork 核心回归；保留 `test:tag-results` 对既有筛选行为的检查。上游目录移动后同步 fixture import，不恢复已废弃的旧目录。
- App 标识保持 `com.hghubx.app`。覆盖安装先正常退出、备份 WebView library，再替换 App；不要卸载或清理数据，不从旧 `com.hghub.huangguo` 容器复制凭据。
- 旧指南完整存档在 [2.1.2 迭代指南](docs/build-history/2026-11-16-v2.1.2-guide.md)，1.3.0 记录在 [历史构建记录](docs/build-history/2026-11-14-v1.3.0.md)。历史路径和测试清单不能当作当前实现。

## 本地构建与交付

- 如本机忽略目录中的 `.ios-build.local/with-env.sh` 仍存在，可用 `bash .ios-build.local/with-env.sh <command>` 复用 Node 22、Rust 和开发签名环境；它不是仓库依赖，不能提交其中的个人路径、团队或设备身份。依赖按锁文件安装，不为打包随意升级。
- Universal：`pnpm tauri build --target universal-apple-darwin --bundles app`，需安装两个 macOS Rust target。通过 `lipo -archs` 检查 arm64/x86_64，并校验签名；Tauri DMG 封装失败时按历史记录使用 staging + Applications 链接 + `hdiutil create`，再校验并只读挂载最终 DMG。
- iOS：使用已有 Xcode 开发账号、正确 Bundle ID 和包含目标设备的描述文件，`pnpm tauri ios build --ci --target aarch64 --export-method debugging --features custom-protocol`。生成工程版本、启动画面及 ATS 按当前脚本核对；保留本机 Rust 环境包装，重建工程后需重新核验。CI 未签名 IPA 与本地开发签名 IPA 不同。
- 合并任务默认包含本地双端打包和现有开发签名，不包含安装；正常 commit/push 按用户授权范围执行。覆盖安装须用户另行明确要求，不沿用历史安装授权。不因上游通用的 CI 交付约定重复索取已获授权；高风险操作按上文先确认。没有授权时不创建标签、发布 Release 或上传签名产物。正常推送前确认分支关系，不强推。
- 本 fork 推送至 `michaelxiao0304/hghubx`；应用内更新链接仍指向 `zxsos/HGhubX`。不要将两者混为同一发布目标。
- 构建、原生签名检查、浏览器 fixture 和真机运行各自报告。Mac ad-hoc 签名不等于公证，iOS 开发包只适用于描述文件包含的设备。安装后比较实际收藏和观看进度，不能只检查版本或容器路径。

本轮 2.2.0 合并、回归、双端安装包与 Mac 覆盖结果见 [fork 同步记录](docs/release-notes/v2.2.0-fork-sync.md)。安装前后按记录内容比较；启动播放后允许同集数/时长、时间戳前进且秒数不倒退的正常进度更新，不能只比较原始 JSON 字符串。

后续旋转误切视频与跨视频断点续播的修复、回归和替换安装包见 [播放修复记录](docs/release-notes/v2.2.0-playback-fix.md)。同为 2.2.0，本次修复产物带 `playback-fix` 后缀；核对源码提交和产物哈希，避免再次安装旧包。
