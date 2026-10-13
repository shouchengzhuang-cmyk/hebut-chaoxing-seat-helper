# Chaoxing Seat Reserver Worker

单账号、单目标时段的 TypeScript Cloudflare Workers 实现：预约、只读监测、持久提交日志、监督待人工处理、经规则核验的有限重约。签到仅提供官方页面入口和结果回读。没有后台签到、退座、取消或解除监督接口。

本次代码尚未在河北工业大学真实接口验证。默认关闭 WRITES_ENABLED、MONITOR_ENABLED、AUTO_REBOOK_ENABLED、REBOOK_RULES_VERIFIED、STATUS_PROFILE_VERIFIED。不要因测试通过就启用生产写入。

## 本地验证

使用 Node >=22.6（验证环境24.19.0）。

    cd worker
    npm ci --ignore-scripts
    npm run check

check运行源码类型检查、Node单元测试、Wrangler离线打包，以及workerd/Miniflare + SQLite Durable Object集成测试。集成测试拦截全部出站请求，无学校真实写操作。build使用wrangler deploy --dry-run，只打包，不部署。原油猴在仓库根目录执行npm run check。

## 持久化为何必要

/run与每日Cron确实可同时发起预约，Worker可能有多个isolate或中途重启。单进程锁无法实现跨请求互斥；KV的最终一致性不能做提交锁。使用一个固定账号级SQLite Durable Object，明确队列跨网络await持锁，保存一个account-v1记录。没有另加KV、D1、Queues或Go服务。

提交前持久保存SUBMITTED_UNVERIFIED。网络丢响应、超时、HTTP错误、无效JSON、成功响应不匹配均为不确定写结果，只回读，不自动重发。服务端正向确认可以恢复；负向空列表不是失败证明。即使重启、持久化最终结果失败或再次触发，未确认意图仍阻止新提交。不要通过删除DO状态或更换对象名来解锁。

明确success=false拒绝后，只有短暂繁忙允许在60秒、300秒等退避后重新读状态，最多三次提交。验证码、认证、规则拒绝为停止条件。每日Cron和手工/run用同一个操作键。监测可继续处理到期的明确繁忙重试。

缓存确认结果仅说明预约提交曾成功，签到/释放/完成以/status中的snapshot为准。程序不使用服务端幂等令牌；这是客户端保守的去重和恢复，不承诺上游具备exactly-once协议。

## 配置

非敏感参数在wrangler.jsonc。保持一个部署对应一个账号，不要在保留日志的部署上切换其他账号Cookie。

| 参数 | 用途 |
| --- | --- |
| ROOM_ID / SEAT_NUM | 房间和精确座位号，默认3747/216，保留前导零 |
| START_TIME / END_TIME | 预约时段，保留08:30–22:00 |
| CHECKIN_EARLY_MINUTES / CHECKIN_LATE_MINUTES | 独立签到窗口偏移，默认各30分钟 |
| API_STYLE | seat（默认）或seatengine，未知代际停止 |
| POLL_SECONDS | 60–900秒，越界截断，无效值用60 |
| WRITES_ENABLED | true才允许预约提交 |
| MONITOR_ENABLED | true才运行监测Cron |
| AUTO_REBOOK_ENABLED | true才考虑释放重约 |
| REBOOK_RULES_VERIFIED | 本校重约规则核验后才设true |
| STATUS_PROFILE_VERIFIED | 状态/字段配置核验后才设true |

用secret配置以下参数，不要提交到Git、粘贴到PR或输出日志：

| Secret | 用途 |
| --- | --- |
| CHAOOXING_COOKIE | 当前账号会话Cookie；不实现自动密码登录 |
| ADMIN_TOKEN | 全部业务路由的Bearer凭据 |
| CHAOOXING_RESERVE_PAGE_URL | 官方预约页，保留学校参数，按目标日期更新day |
| CHAOOXING_HALL_URL | 到馆使用的官方大厅URL，不存二维码或定位 |
| FID_ENC | seat旧代index参数，禁止复制其他学校默认值 |
| SEAT_ID / SEAT_ID_ENC | seatengine新代index参数，两者必须提供 |
| STATUS_PROFILE_JSON | 经本校脱敏证据核验的状态映射和规则字段路径 |

现有CHAOOXING拼写保持兼容。携Cookie的请求禁止跟随重定向。预约URL仅允许https://office.chaoxing.com的对应代际select/code路径；大厅仅允许对应代际index/select/code路径。请求8秒超时，不把上游自由文本写进日志或反射给调用者。

seat调用/data/apps/seat/index（fidEnc+r）；seatengine调用/data/apps/seatengine/index（seatId+seatIdEnc）。getstatus按reserveId查询。两代预约前缀适配，但参数集继续使用原项目的roomId/day/startTime/endTime/seatNum/captcha/wyToken，不擅自加入type/verifyData。

## 状态契约及证据边界

index仅接受success=true，data.curReserves和data.nearReserves为显式数组。记录要求id、roomId、seatNum、today/day/reserveDay、startTime、endTime，status保留原值。时间可为HH:MM或毫秒时间戳，转换为上海日期和分钟。匹配包含房间、精确座位号、日期、起止时间。缺字段、冲突记录、未知码值、接口异常均UNKNOWN。

getstatus目前仅接受success=true且data.seatReserve为完整同ID记录。该响应形状是严格适配契约，尚没有本校样本证明；实际不符时要根据脱敏样本修改适配器，不能把空数据当已释放。

STATUS_PROFILE_JSON结构：states是本校原始状态字符串到以下状态名称的映射：RESERVED_PENDING、SIGNED_IN、REVIEW_REQUIRED、RELEASED、COMPLETED、UNKNOWN。不允许映射UNRESERVED（它只能来自完整查询的空匹配）。未核验配置永不生效，不默认采用iSeatcx的0/1/3/5/9。

可选policyFields必须配置allowed、supervisionPending、blacklisted、seatAvailable四个字段的路径；只能使用data下面的简单字段路径。四个值必须都是JSON布尔值；任意缺失或错误类型，不授予重约许可。字段路径由本校真实返回决定。test/fixture.ts使用虚构英文状态和data.rules.*字段，只用于Mock，绝不是河北工大接口样本。

已知预约从index消失时查getstatus；没有完整明确记录就UNKNOWN，并保留原预约ID。不会从过了10分钟、记录缺失、日期过去或未知错误推断释放/完成。监督事件写入有界事件列表，reviewPending持续生效。只有随后可信的服务器规则字段明确表示不存在监督限制与黑名单，才清除待处理标记；历史事件保留。

## 生命周期限制

初次/run仅在明确未预约时提交。同一目标已有活动记录只作正向确认。释放后的初次/run不能绕过协调器规则。

自动重约必须同时具备明确RELEASED记录、已核验状态映射、规则许可、座位可用、无黑名单、无待监督核验，以及两个启用开关。发送前再次读取。每个释放ID仅有一个操作，最多三次明确失败重试；同一天最多两个释放事件的重约预算。未知写结果停止。

已过原START_TIME时不尝试重约：本轮没有证据证明本校剩余时段和时间网格规则，不自行猜测新起点。此版本支持尚未开始的原时段重约；上课后回馆的剩余时段重约需另行核验再扩展。一次只主动跟踪一个日期/目标。跨天先只读核验旧任务；旧时段已结束且没有未确认提交或已知监督限制时归档，保留30条历史。SIGNED_IN或UNKNOWN可以作为历史状态保存，不被改写成完成/释放。未确认提交必须先由明确匹配的新记录核验，否则显示handoff人工处理原因，禁止删除DO、清空journal或更换对象名。仍不实现多天并行活动任务。

## 路由和现场签到

除GET /health外，全部要求Authorization: Bearer <ADMIN_TOKEN>。

| 路由 | 行为 |
| --- | --- |
| POST /run | 默认dry-run，仅取页面和生成签名 |
| POST /run?commit=1&day=YYYY-MM-DD | 经持久化协调器预约，写入开关默认关 |
| POST /track，JSON含day | 只读查询并跟踪一个日期；不绕过轮询频率 |
| POST /monitor | 推进受频率限制的状态监测；仅启用且符合策略时可能正常预约 |
| GET /status | 读取缓存状态、提交记录和待处理事件，零学校请求 |
| GET /arrival | 返回经域名校验的官方大厅URL和现场扫码说明，零学校请求 |

SUBMITTED_UNVERIFIED返回202，表示需要回读确认；受策略阻止返回409。先在官方页面完成实际到馆扫码/定位/验证码，再等待轮询或调用/monitor；只有服务器映射到SIGNED_IN才确认签到。/arrival不调用sign，不保存或重放二维码，不将按钮点击当在场证明。

## 调度与成本

每日Cron 29 14 * * *以UTC执行，对应北京时间22:29，靠近22:30取token并等待提交；目标日期固定由scheduledTime算出，延迟到午夜不改成错误日期。迟到超过22:30后的15分钟时仅记录CRON_SUBMISSION_WINDOW_MISSED，不提交；提交前再次检查窗口，短延迟可以正常尝试。监测Cron */1 * * * *按不同分支执行。两者默认均不执行业务请求。无跟踪任务、未到轮询时间、已完成时跳过；异常指数退避到15分钟。Cron不保证秒级准点。

根据2026-10-13查询的Cloudflare文档：Workers免费100,000请求/日，HTTP/Cron调用10ms CPU；SQLite DO免费100,000请求/日、13,000 GB-s/日、5百万行读取/日、100,000行写入/日、总存储5GB。DO的get/put也计隐藏SQLite表的行操作。超免费额度会失败，不自动付费。

每分钟Cron最多1440次/日，单账号状态查询每轮一个index，已知ID缺失才补getstatus。不是每秒常驻任务。若每轮最坏16秒网络等待，按128MB估算DO时长约2880 GB-s/日，未计人工请求、排队与其他服务；此为容量估计，不是线上计量。没有在生产验证CPU或网络可达性。

| 组件 | 决定 |
| --- | --- |
| Worker | 保留入口和Cron |
| SQLite Durable Object | 为已确认的跨请求竞争、持久未确认意图引入一个 |
| KV | 不适合幂等锁，不引入 |
| D1 | 不需要多记录关系查询，不引入 |

参考：https://developers.cloudflare.com/workers/platform/limits/ 、https://developers.cloudflare.com/durable-objects/platform/pricing/ 、https://developers.cloudflare.com/workers/configuration/cron-triggers/。

## 最少人工核验

1. 本人正常使用官方页面时，记录当前预约页/大厅URL和代际；提供去敏的index及getstatus响应（待签到、已签到，已有监督/释放事件时再提供对应响应）。去掉Cookie、token、enc、UID及个人资料，不为测试制造监督。
2. 根据样本补齐状态和字段映射，关闭写入先测试/track、/status和/monitor；不符的返回保持UNKNOWN。确认学校关于重约资格、次数、限制与时段的实际规则；无法获取明确资格字段就保持自动重约关闭。
3. 本人到馆通过/arrival打开官方流程，正常现场扫码后用/monitor确认SIGNED_IN。

完成这些核验后才讨论部署及启用写入。本轮不合并、不部署。

## 本轮：跨天归档与签到窗口

/status现在同时输出checkinWindow、archives、handoff和pendingRun。08:30预约对应08:00—09:00签到；边界按窗口包含端点显示。跨午夜会输出前一天或后一天的完整+08:00时间。clockPhase只是本地时间提示，advisoryOnly始终true；09:00过去不能证明签到失败、释放或完成，也不改变08:30—22:00预约参数。

旧account-v1日志进行加字段迁移，不清空原提交记录、监督标记或对象ID。结束的是本地任务时段，archives.serverTerminalConfirmed=false；只有服务器明确给出已验证的终态才为true。历史状态未知但没有未知写意图时可以归档，并记录HISTORY_STATUS_UNVERIFIED；次日预约仍需重新读取次日状态，未知返回会阻止提交。历史SUBMITTED_UNVERIFIED或待监督限制则进入显式handoff阻塞，以1/2/4/8/15分钟退避回读。存在已授权pendingRun时可在恢复后继续；Cron授权超过迟到窗口后失效，不在深夜补发。

未知重约不能由同一旧释放ID确认：例如released:123的新提交丢响应，历史记录123仍显示释放不能解除未确认标记。即使跨天也保留这条意图。

## 脱敏诊断与真实契约

安装开发分支dist中的油猴脚本，在官方大厅、选座或码页找到“只读接口诊断（默认关闭）”。点击开启后，只观察本页正常操作的index/getstatus响应；不主动发请求。整页刷新后重新关闭，不持久化采集开关，也不采集此前加载的响应。已有预约引擎仅在原选座页运行；其他页面仅显示诊断面板。

采集不到时，使用面板的本地粘贴替代：F12 → Network → index/getstatus → Response，复制JSON响应本身。不要复制Headers、请求体、Cookie或HAR。导入后自动清除粘贴原文；停止会清除采集缓存与未导入原文。

白名单保留预约结构、数值状态码、时间和少量布尔规则字段；姓名/UID/Token/enc/任意额外字段被丢弃，预约ID、房间/座位和绝对日期用替代值，HH:MM和状态码保留用于适配。自由文本状态不导出原值，仅保留类型标记。JSON预览后另点确认下载；不上传、不写localStorage、不自动存Git。缓存最多10个样本，每个数组最多100条。

真实状态码尚待用户正常操作时对照官方显示含义确认。离线工具只检查解析，永不标记真实兼容：

    npm run check:contract -- private-diagnostics/sample.json private-diagnostics/profile.json

profile可以配置states、policyFields和responsePaths.current/near/detail（仅data下路径），不要求复制iSeatcx数字。默认仍严格使用curReserves/nearReserves及data.seatReserve；缺失数组、请求错误、空列表或经过签到窗口不推断释放。测试流程说明见test/contracts/README.md，private-diagnostics/已被Git忽略。/status和历史归档展示的原始状态仅来自解析，不自动宣布真实协议已验证。

## 本轮免费额度复核

依旧只有一个SQLite DO。每天每分钟Cron约1440次；常规最多每轮index+getstatus两次，跨天多一次历史核验，重约另有受限回读。阻塞回读按退避执行，不连续每秒碰接口。DO网络等待计wall-clock时长，普通Worker网络等待不计CPU，两者不可混淆。按照单个128MB DO整日不休眠的极保守上界，86400 × 0.125 ≈10800 GB-s/日，低于免费13000 GB-s/日；这是本部署估算，不包含账号其他DO，实际仍需仪表盘观测。免费DO每日100000请求/100000行写入/500万行读取，总存储5GB。没有新增服务或自动付费切换。保留未知意图不以节省费用为理由清除。
