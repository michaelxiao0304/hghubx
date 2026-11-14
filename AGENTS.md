# HGhubX 迭代与构建指南

本文件适用于整个仓库。用中文沟通，先确认实际运行的版本和代码状态，再修改或打包。
当前以 `zxsos/HGhubX` 2.0.0、提交 `bebfb7a` 为实现基线。按用户决定，界面、数据 API、播放器、动态选线和构建流程跟随上游，保留 fork 的 NAT64 网络兼容、文档及本地数据迁移。
1.3.0 完整迭代与打包记录归档在 [docs/build-history/2026-11-14-v1.3.0.md](docs/build-history/2026-11-14-v1.3.0.md)，不要将旧架构说明当作当前实现。

## 项目定位与技术结构

- HGhubX 是第三方内容客户端，主要提供短剧浏览、搜索、分类、图文帖子、在线播放、收藏、观看历史和账号互动。
- 前端使用 React 19、TypeScript、Vite 7、Tailwind CSS 4；原生壳和网络层使用 Tauri 2、Rust。播放引擎使用 hls.js，并支持 WebView 原生播放路径。
- 完整功能依赖 Tauri IPC；单独运行 Vite 不等于可以在普通浏览器中访问全部业务功能。
- 项目不托管内容，也没有视频下载功能。保留现有许可证与版权声明；测试优先使用本地 fixture，避免对真实站点批量请求。

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx`、`src/pages/`、`src/components/` | 桌面与移动界面、播放器、设置、线路与代理入口 |
| `src/store.tsx`、`src/storage.ts` | 个人记录、播放偏好、主题、版本间存储迁移 |
| `src/api.ts`、`src-tauri/src/api.rs` | Tauri IPC 和业务接口 |
| `src/autoLine.ts`、`src-tauri/src/lines.rs` | 发布页镜像解析、自动探测、线路切换与取消 |
| `src-tauri/src/net.rs`、`proxy.rs`、`apple_proxy.rs` | 网络、应用代理与 Apple 系统代理判断 |
| `src-tauri/src/network_policy.rs`、`media.rs` | 网络安全策略、NAT64 兼容、媒体代理与缓存 |
| `src-tauri/src/source_migration.rs` | 1.3.0 接入地址迁移 |
| `src/components/Player.tsx`、`VideoSurface.tsx`、`src/useProxyPlaybackRecovery.ts` | HLS / 原生播放、代理变化后的续播恢复 |
| `src-tauri/src/ios_layout.rs`、`macos_titlebar.rs`、`linux_http.rs`、`linux_webview.rs` | 平台适配 |
| `src-tauri/tauri*.conf.json`、`.github/workflows/`、`scripts/` | 打包配置、CI 和验证脚本 |

业务接口与播放器使用上游结构。原 fork 的 `data_call/services/edge_v1`、`src/player/`、`SourceGate` 已随本次同步移除；后续改动基于当前文件，不能沿用旧路径。

## 接入地址与账号：当前真实行为

- 使用上游内置默认线路、可信发布页镜像、自动选线、手动选线、自定义 HTTPS 镜像及应用代理设置。
- 自动选线默认开启，受保存的开关控制；启动、网络变化和连续失败触发选线或体检，全部失败时保持原线路。发布页不可用不代表能自动找出任何新域名。
- 手动保存线路/镜像会关闭自动选线，用户可在“设置 → 网络”重新打开；手机与桌面共用逻辑，各设备独立保存配置。
- 自定义镜像只接受 HTTPS 根地址，不允许路径、查询参数或凭据，并继续执行网络安全检查。
- `line.json` 保存当前线路，`proxy.json` 保存应用代理配置；代理支持跟随系统、自定义和直连。
- 自动切线与手动选择/取消有代次保护，旧探测结果不能覆盖新的手动选择。
- 会话按 origin 隔离；跨站点切换可能需要重新登录。迁移地址不转移其他 origin 的 token。
- 播放接口本地不强制登录；评论、点赞等操作需要账号，最终访问权限由站点决定。
- 默认域名和发布页跟随上游实现；代码中的地址不能描述为已确认当前可访问的官网。

## 数据迁移与网络兼容

- 当前 App 标识仍为 `com.hghubx.app`，覆盖 1.3.0 时保留同一 WebView 存储；不要先卸载或清理应用数据。
- `src/storage.ts` 读取 fork 的 `app_data_v1:default:library`、上游的 `hghubx_app_v1`，兼容旧 `hghub_app_v1`。
- 收藏/点赞/关注/搜索记录合并去重；同一视频的观看记录取较新的 `at`，保留集数、秒数和总时长；时间相同优先 fork，旧数字 ID 记录不能覆盖有时间的进度。
- `hghubx_library_backup_v2` 保存迁移前原始值，旧 library 键保留。迁移标记 `_libraryMigration: 2` 与合并数据一次写入；之后清空历史或取消收藏不能被旧数据恢复。
- 备份或目标写入失败时，原值不覆盖；当次可读取内存中的合并结果，后续启动重试。用 `pnpm test:storage-migration` 覆盖失败、重启、重复记录及格式损坏场景。
- 原 `source.json` 仅在 `line.json` 不存在时导入，保留原文件。无效地址不放宽上游安全要求；错误信息不包含原始地址或凭据。
- 保留 fork 对 `64:ff9b::/96` NAT64 的处理：按内嵌 IPv4 判断，允许公共地址，仍拒绝内网/回环。与上游代理路由、IPv6 优先及 SSRF 策略共同工作。
- 不自动迁移旧 `com.hghub.huangguo` 应用容器；不同 Bundle ID 的数据不能当作同一存储。不得从旧容器批量复制账号凭据。

## 平台与安装包

平台范围以工作流与各平台配置为准；2.0.0 发布说明列出以下五个平台。

| 平台 | 当前打包方式 | 约束 |
| --- | --- | --- |
| Windows | x64 NSIS `.exe`，CI 另外生成便携 `.zip` | 默认通用配置中的 bundle target 是 `nsis` |
| macOS | `.app` 和 `.dmg` | ARM64 可单独构建；CI 非 quick 模式构建 Intel + Apple Silicon Universal |
| Android | 按 ABI 拆分的 `.apk` | ARM64、ARMv7、x86_64；最低 API 24；CI 签名依赖 Android secrets |
| iOS | ARM64 `.ipa` | 最低 iOS 15；CI 产物未签名，本地可用已有开发账号导出签名包 |
| Linux | amd64 `.deb` | 当前没有配置 RPM 或 AppImage；依赖见 `tauri.linux.conf.json` |

工作流的 quick 模式下，macOS 和 Android 只构建 ARM64。实际执行构建并检查产物后才能报告“构建成功”，配置中存在某平台不等于其产物已经验证。

## 开发环境与常用命令

从仓库根目录运行。优先使用 Node.js 22、pnpm 和 Rust stable；Rust 清单最低版本为 1.90。
保留锁文件，不为解决构建问题随意升级依赖。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm app:dev
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

- `pnpm build` 包含应用和测试 fixture 的 TypeScript 检查以及 Vite 生产构建，不等于执行所有测试。
- CI 使用 pnpm 10；本次本机使用 pnpm 11.25.0。pnpm 11 提示 `package.json` 中 `pnpm.*` 不再读取时，先检查 `pnpm-workspace.yaml` 的对应配置，不要直接删除兼容 CI 的设置。
- 保留 hoisted 布局及 esbuild 安装脚本配置，相关解释已写在 `pnpm-workspace.yaml`。
- 本机默认 shell 曾使用 Node 20，但构建时切换到了已安装的 Node 22；先检查实际 `node --version`，不要只凭“已经安装”判断 PATH 正确。

### 本轮本地工具链的复用

本轮发现本机没有 Rust，将工具链装在被忽略的 `.ios-build.local/` 中，没有要求修改全局 shell 配置。
若这些本地文件仍存在，可以通过以下包装脚本复用 Rust 和 Node 环境：

```sh
bash .ios-build.local/with-env.sh pnpm build
bash .ios-build.local/with-env.sh pnpm tauri build --target aarch64-apple-darwin
```

这个脚本是本机文件，不随 Git 分发，并包含本机路径及开发团队配置。换机器应自行配置 Node、Rust、Xcode 和签名环境，不能把该文件视为仓库依赖。
仅在复用本地 Rust 安装时，将 `CARGO_HOME` 和 `RUSTUP_HOME` 指向 `.ios-build.local/cargo`、`.ios-build.local/rustup`，并把前者的 `bin` 加入 PATH；不要对已有正常工具链盲目覆盖环境变量。

## macOS ARM64 打包

```sh
rustup target add aarch64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin
```

Tauri 自动合并 `tauri.macos.conf.json`，输出：

- App：`src-tauri/target/aarch64-apple-darwin/release/bundle/macos/HGhubX.app`
- DMG：`src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/HGhubX_<version>_aarch64.dmg`

需要 Universal 时先安装 `aarch64-apple-darwin` 和 `x86_64-apple-darwin`，再使用 `--target universal-apple-darwin`。

验证至少包含：

```sh
lipo -archs src-tauri/target/aarch64-apple-darwin/release/bundle/macos/HGhubX.app/Contents/MacOS/hghubx
codesign --verify --deep --strict --verbose=2 src-tauri/target/aarch64-apple-darwin/release/bundle/macos/HGhubX.app
hdiutil verify src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/HGhubX_1.3.0_aarch64.dmg
```

最后一条命令的版本号按实际产物替换。只读挂载最终 DMG，检查包内 App 的版本、架构、签名及 Applications 快捷入口，检查后卸载。

- 配置 `signingIdentity: "-"` 表示 ad-hoc 临时签名。签名完整性通过不等于经过 Apple 公证；本轮 DMG 没有公证。
- 新版是 `HGhubX.app` / `com.hghubx.app`。本机发现的旧版是 `HGhub.app` 1.2.0 / `com.hghub.huangguo`，拖入 Applications 后会并存，不会自动覆盖旧名称。
- 向用户明确应打开哪个 App；不要默认旧版数据目录、登录状态和新标识之间有自动迁移。

## iOS 本地开发签名打包

准备完整 Xcode、Command Line Tools、Rust iOS target，以及可用的开发证书和描述文件。
用 `xcode-select -p`、`xcodebuild -version`、`security find-identity -v -p codesigning`、`xcrun devicectl list devices` 核对环境。
Team ID 从 Xcode 或描述文件确认，不要把证书显示名称末尾的标识直接当作 Team ID。

```sh
rustup target add aarch64-apple-ios
export APPLE_DEVELOPMENT_TEAM="<本机开发团队的 Team ID>"
pnpm tauri ios init --ci --skip-targets-install
pnpm tauri ios build --ci --target aarch64 --export-method debugging --features custom-protocol
```

`--skip-targets-install` 仅在所需 Rust target 已安装时使用。`ios init` 可能通过 Homebrew 安装 XcodeGen、libimobiledevice 等原生工具，环境里还需要 CocoaPods。

- 正常导出位置：`src-tauri/gen/apple/build/arm64/HGhubX.ipa`。
- 本轮使用 Release 编译配合 `debugging` 导出方法；后者表示开发签名分发方式，不代表使用 Rust debug 编译配置。
- 描述文件必须匹配 Bundle ID、开发团队、证书，并包含要安装的真机。开发签名包不能承诺安装到任意设备。
- 生成工程后，按 `.github/workflows/release.yml` 的 iOS 初始化步骤核对 Info.plist 的方向与 ATS 配置。本轮对生成的 Info.plist 应用了该工作流的现有设置。
- 验证最终 IPA 的 ZIP 完整性；解包后校验实际 Payload App 的签名、版本、ARM64 架构、最低 iOS 版本、描述文件有效期和目标设备匹配情况。
- 编译和签名校验不代替真机安装、播放或账号功能测试，交付时说明实际验证范围。

### 本轮遇到的 Xcode 环境问题

第一次 iOS 编译在 Xcode 的 `Build Rust Code` 阶段失败：

```text
rustup could not choose a version of cargo to run ... no default is configured
```

原因是 Xcode 子进程没有继承本地 Rust 安装所需的 `CARGO_HOME`、`RUSTUP_HOME`。
本轮解决方式是在生成工程的构建阶段，通过本地 `with-env.sh` 包装原来的 `pnpm tauri ios xcode-script ...`，显式恢复环境；同时同步了 `src-tauri/gen/apple/project.yml` 和生成的 `project.pbxproj`。

这些文件被 Git 忽略，重新执行 `ios init` 会重建工程，必要时需重做本地环境适配。正式迭代若需要复用修复，应将可移植的处理写进受版本管理的脚本或配置，而不是提交含本机绝对路径的生成工程。

### 未签名 CI 流程与其他陷阱

- `scripts/build-ios-unsigned.sh` 是仓库现有的未签名 IPA 路径，和上述本地开发签名导出用途不同。
- Tauri 的 `ios xcode-script` 需要活动的构建选项服务。直接单独跑 Xcode 归档可能缺少该服务；未签名脚本为此维持 `tauri ios build --open` 会话。
- 保留 Cargo 的 `custom-protocol` feature。不要把旧的 `scripts/patch-ios-pbxproj.py` 当作当前默认流程，它采用另一种直接构建静态库的方案。
- Swift 兼容库路径及 `TOOLCHAIN_DIR` 的处理参考现有未签名脚本，不要为解决链接错误随意添加忽略未定义符号的参数。
- Release 二进制中可能仍包含配置里的 `localhost:1420` 字符串；仅凭这个字符串不能判断是开发包。
- 在受限执行环境中，曾出现 `security find-identity` 返回 0 个身份、`codesign` 报 `CSSMERR_TP_NOT_TRUSTED`，访问系统钥匙串后检查通过。先区分环境权限与证书问题，不要立即重建或删除证书。

## 播放问题排查

1. 先确认用户实际打开的 App 路径、Bundle ID 和版本。本轮 Mac 排查发现本机已安装旧版 1.2.0，其已知接口问题与用户报告相符；未取得此次播放响应，不能断言它是唯一原因。此前构建 iOS 并不会更新本机 Mac App。
2. “暂无播放地址”来自 `src/components/Feed.tsx` 没有取得主播放源，发生在媒体解码之前。不要仅凭这个提示归因于 macOS 解码器、HEVC、缺少登录或安装包签名。
3. 历史提交 `cfcde4a` 修复上游播放协议变化：旧请求仍可能返回成功，但旧地址字段为空；后续提交 `d46fe31` 增加回退和字段归一化。当前 `src-tauri/src/api.rs` 的 `api_play` / 字段归一化逻辑及播放页兼容 `streams.main` 与 `video_url`，高清字段也有新旧映射。
4. 区分“HTTP 请求成功”“业务成功”“响应映射后存在播放源”“媒体实际播放成功”。前端日志里的 `status=?` 不能直接当作上游没有错误的证据；必要时在 Rust API/网络层增加脱敏诊断。
5. 本轮旧版日志另有分类请求的 `HTTP 410 Gone` / “内容已下线”，这只能证明该请求返回了下线信息，不能用来断定所有视频或整个站点失效。
6. 内容是否可播放还取决于当前接入地址及上游接口；历史修复和成功打包都不能证明站点当前可用。

日志入口：应用数据目录中的 `debug.log`；可选播放诊断日志为 `playback.log`，设置页也提供网络诊断和日志复制。
macOS 当前默认数据目录是 `~/Library/Application Support/com.hghubx.app/`；旧版可能使用 `com.hghub.huangguo`。其他平台通过 Tauri 的 `app_data_dir()` 定位，不要写死本机用户名。

日志与报告只保留必要的状态、耗时、域名等诊断信息，不输出账号密码、token、完整签名媒体链接或证书私钥。
网络与媒体改动应保留现有来源隔离、重定向、SSRF 和缓存策略；不要用关闭全部安全检查替代定位问题。

## 验证与迭代范围

按修改内容选择已有检查，不因一次文档修改重编所有平台，也不为低风险改动机械增加测试。

| 改动范围 | 相关检查 |
| --- | --- |
| 前端类型、界面或数据契约 | `pnpm build`，再选择受影响的 fixture 测试 |
| 播放、进度拖动、生命周期 | `pnpm test:playback`；平台相关行为还需对应原生 WebView 验证 |
| 加载失败与重试 | `pnpm test:api-loading` |
| 频道分页 | `pnpm test:channel-pagination` |
| 移动导航和布局 | `pnpm test:mobile-layout` |
| 诊断报告复制 | `pnpm test:diagnostic-copy` |
| 存储与旧接入迁移 | `pnpm test:storage-migration`、`cargo test --lib source_migration` |
| 动态选线与代理 | `pnpm test:line-selection`、`pnpm test:network-settings` |
| Rust 业务、网络或原生层 | 按需运行 `cargo check --all-targets`、`cargo test --lib` 及对应平台构建 |
| 纯文档 | 核对路径、命令和事实，运行 `git diff --check` |

浏览器脚本使用 `playwright-core`，需要可用的 Chromium/Chrome；多数脚本支持 `BROWSER_EXECUTABLE`，播放脚本还支持 `--browser-executable`。
播放 fixture 默认通过 ffmpeg 生成本地测试媒体，也可使用脚本的 `--media-dir` 参数。测试产物写入 `test-results/`。
模拟 Tauri IPC 的 Chromium 测试不能代替 iOS/macOS WKWebView、原生媒体协议和真实设备验证。

## 2026-11-14 的 1.3.0 历史构建记录

- 环境：Xcode 27.2（27B52）、Node 22.23.5、pnpm 11.25.0、Rust 1.100.0；这些是本次记录，不是项目新增最低版本要求。
- 前端类型检查及 Vite 生产构建通过。
- iOS 1.3.0：ARM64、最低 iOS 15，使用已有 Apple Development 身份导出；IPA 完整性、解包后签名和描述文件匹配检查通过，描述文件包含当时连接的 iPhone。
- macOS 1.3.0：ARM64 App 和 DMG 构建成功；最终 DMG 校验及包内 App 版本、架构、签名完整性检查通过；签名为 ad-hoc，未公证。
- 本轮没有完成真机安装与实际内容播放回归，也没有执行全部浏览器/Rust 测试；不要把上述结果扩展为所有功能已通过。
- 本轮整理的交付文件在 `src-tauri/target/ios-release/` 和 `src-tauri/target/macos-release/`，各自有 `build-info.json` 与 SHA-256 文件；这些是本地副本，不是 Tauri 默认输出路径，也不随 Git 分发。
- 构建日志在 `.ios-build.local/` 和 `.macos-build.local/`。本轮 Cargo 曾仅重排 `Cargo.lock` 中项目条目的位置，确认无语义变化后已恢复，未升级依赖。

## 提交与发布

- 修改前后检查 `git status`，只提交本次任务相关文件，保留其他人的改动。
- `AGENTS.md` 是共享项目文档，应纳入 Git；`*.local`、`src-tauri/gen/`、`src-tauri/target/`、依赖和测试产物继续保持忽略。
- 不提交个人绝对路径、开发团队身份、设备标识、描述文件、签名证书或私钥。构建产物交付用户或通过发布流程管理。
- 更新版本时使用 `scripts/set-version.mjs`，核对前端、Tauri、Cargo 和 Android versionCode 的一致性。
- 提交和推送以用户授权的范围及 `git remote -v` 为准。本轮远端为 `michaelxiao0304/hghubx`；代码中的项目链接和更新检查仍指向 `zxsos/HGhubX`，两者不是同一个发布目标。以后调整 fork 的更新渠道时同时核对前端项目链接与 `src-tauri/src/api.rs`。
- 推送前同步并确认分支关系，正常推送，不强推。本地打包不需要创建版本标签；推送 `v*` 标签会触发发布流程。
- 交付说明应写明文件位置、版本、架构、签名/公证状态、实际验证范围及重要安装差异。

## 2.0.0 合并与本机构建注意事项

- 上游合并点为 `bebfb7a`；保留 NAT64、本文档及 1.3.0 文档归档，并添加数据迁移回归。
- pnpm 11 默认在运行脚本前自动检查并安装依赖；本次依赖版本/锁文件不变时，该检查仍尝试下载其他平台的可选包。在已确认安装完整后，可仅在本地环境设置 `pnpm_config_verify_deps_before_run=false` 复用依赖，避免反复安装；不要据此跳过缺失依赖。
- Universal 构建需要同时安装 Rust 的 `aarch64-apple-darwin`、`x86_64-apple-darwin` target，执行 `pnpm tauri build --target universal-apple-darwin`，交付时必须用 `lipo -archs` 验证两种架构。
- iOS 图标沿用上游生成/同步脚本；现有生成工程仍需保留本机 Xcode Rust 环境包装。
- 具体迁移策略及本次验证结果见 `docs/release-notes/v2.0.0-fork-sync.md`。
- 本次 Universal App 编译、ad-hoc 签名通过；Tauri `bundle_dmg.sh` 在本机退出失败。使用 `ditto` 复制 App 到独立 staging 目录、添加指向 `/Applications` 的链接，再用 `hdiutil create -srcfolder <staging> -volname HGhubX -fs HFS+ -format UDZO <output.dmg>` 封装。最终映像和只读挂载后的双架构 App 均已验证；上游 CI 构建流程保持不变。
- iOS 2.0.0 已通过现有账号开发签名导出及 IPA、描述文件、设备匹配校验。复用生成工程时同步 Info.plist 和 project.yml 的版本，保持本机 Rust 环境包装，勿交付旧导出目录里残留的 1.3.0 IPA。
- 本次 Rust 79 项单元测试通过、4 项联网测试跳过；前端构建、迁移、网络、UI 和播放 fixture 通过。触控延迟断言在并行编译时曾失败，独立复测原阈值通过；不要为消除这类负载波动放宽生产行为或直接删断言。
- 本机缺少 FFmpeg，播放测试通过忽略目录中的独立 FFmpeg 工具生成本地 HLS；设置 `FFMPEG_PATH` 指向工具后执行测试，无需修改全局系统环境。
