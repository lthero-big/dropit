# RHEA-226 最终 Rust 集成验收

2026-11-25。结论：固定集成版本的完整验收通过，可以提交人工审阅。main 合并、外部镜像发布和生产切换未执行。

## 精确版本

- 测试 commit：`e3921c111e14fa55fcfc49ea51446026aea49227`，来自 `migration/rhea-226-rust`；开始与结束均核对干净工作树和固定 HEAD。
- 标准 Dockerfile 镜像：`sha256:3bd6423ed70c6edf2bb0d9e7e3ee65d8b5a262bb45952fe84f349b7cb4c712e1`。
- OCI revision：`e3921c111e14fa55fcfc49ea51446026aea49227`；version `0.1.0`；build date `2026-11-25T03:39:34.476Z`。
- 独立新构建 Rust 二进制 SHA-256：`5eaeddb5338e4110c34c30e9b4ebb619927a913e156a088adfb695c6af19cc7a`。完整入口未借用其他 checkout 的运行二进制。
- 执行时间：2026-11-25T03:38:14.148Z 至 2026-11-25T03:46:50.624Z。
- 前台命令正常退出 0：`env -u FORCE_COLOR -u NO_COLOR node scripts/rust-final-acceptance.mjs e3921c111e14fa55fcfc49ea51446026aea49227 ../final-rust-e392-evidence`。
- 另行在同一 source commit 通过 `cargo fmt --check` 和严格 `cargo clippy --locked --offline --all-targets -- -D warnings`。Clippy复用本工作区编译缓存；完整入口使用自己独立的新 target 和镜像。

## 完整入口结果

全部15组在同一次前台调用中完成，manifest.passed=true，无失败、无跳过的组。

| 组 | 结果 | 退出码 |
| --- | --- | --- |
| dependencies | passed | 0 |
| ts-clients | passed | 0 |
| playwright-install | passed | 0 |
| rust-build | passed | 0 |
| rust-image-build | passed | 0 |
| rust-tests | passed | 0 |
| image-runtime | passed | 0 |
| docker-cleanup-regression | passed | 0 |
| docker-blackbox | passed | 0 |
| browser-setup | passed | 0 |
| browser-smoke | passed | 0 |
| browser-files | passed | 0 |
| admin-fixture | passed | 0 |
| historical-ts-image | passed | 0 |
| volume-rehearsal | passed | 0 |

## 实测覆盖

- Rust：13个测试目标、29个用例通过，0 ignored；包括17单测、原固定TS兼容进程测试、690 Unicode、526 HTTP/WS实时检查、房间分片并发和即时清理、OAuth状态/错误/限流、密码/PAT/设备码/CLI/WebView、条目/标签/分组、房间分享、更新和353上传响应。
- Docker严格黑盒28/28：OAuth的429、Retry-After与XFF断言通过。所有本次 runtime/browser/卷演练使用上述同一个不可变Rust image ID。
- Docker负向清理6/6：prod/dev占用端口、错误image ID、报告写失败、注入单次删除失败、普通断言路径。只允许注入的删除失败留下可追踪错误，随后由探针精确回收；所有10个探针实际创建的容器及其匿名卷均验证已删除。
- Web浏览器：4 passed / 1 skipped，0 unexpected / 0 flaky。唯一跳过项为固定TS专用的自定义代理短下载断言，不是Rust业务失败；setup 1/1、文件/预览10/10。移动/桌面视口截图已检查，截图随证据交付。
- Runtime：无Node、静态Web、标准metadata、UID/GID1000、0700数据根、SQLite health、SIGTERM和容器重启均通过。
- 隔离历史数据：真实TS schema15 fixture升级到19并保留旧房间，生成pre-v15备份；全部离线归档恢复的文件SHA-256清单一致；旧UID/GID卷兼容。
- 同卷回退：TS既有文本和上传由Rust读取；Rust写入文本/文件由历史TS读取并继续写入；随后Rust管理命令恢复密码和强制改密登录通过。历史TS参考独立固定为 `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`，镜像 `sha256:72a7d5d65a32bee78545e0bd58d15251fb856ee388e9f2c7791658ff95ee2eba`。

## 清理、边界与后续

最终manifest清理成功；额外库存检查确认本次测试前后相关容器和具名演练卷均为空，探针匿名卷无残留，临时Rust/TS镜像tag已删除，入口scratch已清理。镜像ID是本次已验证候选的证据，不表示服务正在运行；可按记录的源码和构建参数重建。

测试仅使用合成账号、隔离数据库、临时卷和loopback端口，没有生产数据或真实OAuth凭据。OAuth使用本地mock provider；移动端覆盖HTTP/WS协议和浏览器移动视口，不宣称真机UI验证。WebP按尺寸/方向等语义对照，非字节全等；提交的README仍明确保留HEIC、非8bit/动画AVIF等解码边界和非ISO构建日期输入边界，本次未声称任意媒体编码或外部服务组合均等价。

测试候选的GitHub一次快照为7项成功、2项publish跳过，未等待或轮询外部CI。后续验收记录PR只改变文档，不改变上述测试候选、运行代码或已验证镜像metadata；不会把记录提交的SHA冒充已执行的候选。

22个子任务全部完成。父任务送in_review，总览PR #73送人工审阅；发布负责人按既有流程另行处理main合并、生产备份/切换和观察。
