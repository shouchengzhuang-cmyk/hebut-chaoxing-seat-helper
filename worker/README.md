# Worker：单账号运行期计划与预约协调

当前入口由 `PlanCoordinator` 串行化配置、Cron、手工预约与只读监测，再复用原 `LifecycleCoordinator` 的持久写前日志。只有一个固定账号 SQLite DO；未新增依赖、服务、DO migration 或付费队列。真实学校协议仍待核验，本轮未部署。旧验证记录保留在 VALIDATION.md，本轮以 ../docs/TEST_MATRIX.md 为准。

## 开发与完整验证

Node >=22.6，推荐 Node 24。本轮 Windows 实测 Node 24.15.0 / npm 11.12.1。

```powershell
npm ci --ignore-scripts
npm run check
```

check 包含 TypeScript、Node 单元测试、`wrangler deploy --dry-run` 打包和真实 workerd/SQLite 集成。所有学校请求在集成测试中被拦截，CI 不部署、不进行真实预约。根目录另运行 npm run check；已提交 dist 必须与构建一致。

`node scripts/preview-control.mjs` 提供 127.0.0.1:18765/control 离线 UI，不加载 .dev.vars，公开合成令牌为 LOCAL_PREVIEW_ONLY，写入关闭且出站全部拦截。测试不是本校契约或真实 GUI 通过证明。

## 配置与 secrets

保留现有 ROOM_ID/SEAT_NUM/START_TIME/END_TIME 仅用于首次迁移。迁移保持暂停、QUERY_ONLY，不更改旧 journal；以后在 /control 修改计划，无须改源码、vars 或重新部署。一个账号同时协调一个活动日期和目标，未来计划有生效版本，不并行批占多个座位。

以下值由维护者在本地通过 `npx wrangler secret put <NAME>` 输入，不能写 Git、URL、日志或 PR：

| Secret | 用途 |
| --- | --- |
| ADMIN_TOKEN | 独立控制页/API Bearer；不放入官方页和油猴 |
| CHAOOXING_COOKIE | 本人正常登录的有效会话；不实现密码登录 |
| CHAOOXING_RESERVE_PAGE_URL | 对应 seat/seatengine 官方 select/code 页上下文 |
| CHAOOXING_HALL_URL | 经官方域名与路径白名单核验的到馆入口 |
| FID_ENC | seat 代际 index 所需本校参数 |
| SEAT_ID / SEAT_ID_ENC | seatengine 代际 index 所需本校参数 |
| STATUS_PROFILE_JSON | 经官方 UI 对照的 states、responsePaths、policyFields |
| RESERVATION_RULES_JSON | 经核验的房间规则数组，结构见下文 |
| SUBMIT_CONFLICT_PROFILE_JSON | 可选的明确座位冲突码契约 |

现有 CHAOOXING 拼写保持兼容。学校请求不跟随携凭据重定向，8 秒超时，业务错误仅返回内部安全代码。select 页面请求同步目标房间 id 和日期，未知房间规则仍阻止提交。

默认保留 WRITES_ENABLED、MONITOR_ENABLED、AUTO_REBOOK_ENABLED、REBOOK_RULES_VERIFIED、STATUS_PROFILE_VERIFIED 全部 false。新增 RESERVATION_RULES_VERIFIED / SUBMIT_CONFLICT_PROFILE_VERIFIED 缺省等于 false；不因离线全绿设置 true。开启属于另行批准的生产配置操作，可由 secret 或经审阅的 vars 配置；本轮没有改这些值。

RESERVATION_RULES_JSON 是最多 20 个规则对象的数组，字段：evidenceId（非敏感来源编号）、roomId、validFrom/validThrough（ISO 日期）、advanceDays（0–30）、openTime、startTime/endTime（HH:MM）、stepMinutes、minMinutes、maxMinutes（正整数分钟）。同一房间/日期必须恰好命中一条；失效、重叠、未知规则拒绝。网格从房间 startTime 起算，跨午夜时段暂不支持。维护者须记录每项与学校规则的对应证据，不能直接复制测试数据。

STATUS_PROFILE_JSON 沿用现有契约：states 只映射实际核验状态，不采用别校数字；responsePaths 仅允许 data 下简单路径。policyFields 的 allowed、supervisionPending、blacklisted、seatAvailable 必须都是明确 JSON 布尔值且语义适用于目标，否则初始预约也停止。getstatus 形状不符、缺数组、零 ID、未知状态、他约或矛盾记录保持 UNKNOWN。

可选冲突契约只支持 `{evidenceId, codeField: "code", codes: [...]}`，codes 为最多 10 个精确字符串/整数，类型必须匹配。仅 success=false 且没有认证、验证码、风控、重复预约或限流提示时可判明确冲突。缺少正式失败语义证据不启用，不能从泛化“预约失败”自动换座。

## 路由

除 GET /health 和不含私密数据的 GET /control 外，全部 Bearer 认证。不启用 CORS，控制页与 API 同源；拒绝跨站 Origin/Sec-Fetch-Site 和 URL 凭据。JSON 请求最大 16KiB，非法字段拒绝。控制页 nonce CSP、禁止 framing、令牌仅内存保存。

| 路由 | 行为 |
| --- | --- |
| GET /plans | 读取/首次安全迁移，零学校请求 |
| PUT /plans | `{revision, plan}` 完整白名单计划；CAS + 审计 + 生效日期 |
| POST /preview | `{day}` 已保存计划的纯本地规则校验，零学校请求 |
| POST /run[?day=YYYY-MM-DD] | 无 commit 时模拟已保存计划；无 DO 的旧兼容入口仅页面 dry-run |
| POST /run?commit=1&day=YYYY-MM-DD | 通过计划和学校门禁的一次预约/有条件重约 |
| POST /pause | `{paused: true/false}` 全局暂停/恢复，不取消、不清账本 |
| POST /track | `{day}` 只读跟踪，不能替换活动日期；初次真实写仍由 /run 协调跨天 |
| POST /monitor | 限频只读监测，不暗中预约 |
| POST /checkin | 限频只读签到回查，没有签到写入 |
| GET /status | 缓存计划、今天明天目标、预约/签到状态、退避、历史、门禁，零学校请求 |
| GET /arrival | secret-backed 官方大厅入口，零学校请求 |
| POST /notifications/claim | `{day, noticeKind: "EARLY"/"DEADLINE"}` 有效提示阶段原子领取，跨标签/重启去重 |

未知提交返回 HTTP 202，阻断/写关闭返回 409，CAS 冲突 409，非法输入 400，超长 413，错误内容类型 415。保存不等于学校预约。公开状态移除完整预约 ID、原始状态自由文本；实际 ID 保留在私有 DO 才能恢复回读。

## 调度、签到与状态

使用现有每分钟 Cron，读取当前已核验房间 openTime/advanceDays，最多扫描 31 个日期；开放后 15 分钟内且预约未开始才运行。不是固定 22:30，旧 14:29 UTC 注册由新版忽略。重复 Cron/按钮共享同一队列。明确忙碌沿用有界退避，单次请求读取至少间隔 60 秒，未知提交只回查；候选只有明确冲突才推进并等待至少一分钟。Worker 机器时间未测量与学校时钟偏差，不提供毫秒保证。

现场签到必须本人满足官方扫码/定位/校园网/人工前置条件。CheckinCoordinator 只认 VERIFIED_STATUS_PROFILE 的同预约 SIGNED_IN；没有无人值守签到 transport。30/30 分钟 CHECKIN_EARLY_MINUTES/CHECKIN_LATE_MINUTES 只是 advisory 提示，不是校方认证窗口，不改变预约时段。

没有取消/退座写接口。已确认释放重约保留原预算（每释放 ID 一次操作、每日最多两个释放事件）和原授权日志，另要求运行期计划、规则、资格与全部开关；预约开始后不补剩余时段。普通监测永远只读，预约/重约只由显式执行或已启用的自动调度推进。不能从消失或时间经过推断释放。

## 发布、观察与回滚

本轮只能 dry-run。发布前完成 ../docs/EXTERNAL_VERIFICATION.md 和 RELEASE_CHECKLIST.md，并获得授权，再执行 `npm run deploy`。保持 DO binding SEAT_ACCOUNT、类 SeatAccount、对象 single-account-v1 和 migration v1-seat-account；不要 reset DB、换对象名、清空未知日志或切换账号 Cookie。

观察：snapshotAt、nextPollAt/nextRunAt、handoff、SUBMITTED_UNVERIFIED、plans.audit、候选 cursor、错过窗口事件。没有原始响应/秘密进日志。常规分钟监测 1440 ticks/日；无已知 ID 缺失时每次一个 index，缺失 ID 可能加 getstatus，受控提交前额外回读。真实 CPU、DO wall-clock、免费额度和账号其他应用占用没有测量，发布前核对官方当期计费，发布后看 Dashboard；不把静态容量估算当实际账单。

回滚先 /pause，关闭写入，私有备份原状态，然后选择理解新增计划 schema 的版本。旧版本会忽略计划并读取旧 vars，也可能丢弃新增字段，因此不能直接把旧代码作为安全运行方案。任何恢复必须保留不确定提交和监督状态。CI/真实场景验证、Git 推送/生产部署分别记账。
