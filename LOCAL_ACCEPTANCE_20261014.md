# 本地集成验收报告

日期：2026-10-14（Asia/Shanghai）。结论：WSL 本地功能验收通过；学校接口契约和生产部署条件尚未完成核验，不能据此启用生产写入。

## 环境与分支

- Windows 仓库：`D:\Projects\hebut-chaoxing-seat-helper`；WSL 路径：`/mnt/d/Projects/hebut-chaoxing-seat-helper`。
- 实际测试环境：Ubuntu 24.04.4 LTS / WSL2，内核 `6.18.33.2-microsoft-standard-WSL2`。
- WSL Node.js `v24.19.0`，npm `11.17.0`，来自 `/home/scz/.nvm/versions/node/v24.19.0/bin/`。满足项目 Node 版本要求。
- Windows Node.js `v24.15.0`、npm `11.12.1` 仅作环境盘点；测试证据全部来自 WSL。
- 初始分支 `main`，工作区无未提交修改。执行 `git fetch origin` 后，创建本地跟踪分支 `feat/worker-seat-lifecycle-20261013`，执行 `git merge --ff-only origin/feat/worker-seat-lifecycle-20261013`，结果 `Already up to date.`。
- 基准 HEAD：`96349c15fda25fd939f6d65f69d9d429518ecf36`；与远端开发分支提交差异 `0 / 0`。修复仅留在本地工作区，未提交或推送。
- PR #1 已关联本会话；未修改、合并或发布 PR。
- 实际工具版本：Wrangler `4.135.0`、TypeScript `5.9.3`、Workers types `5.20260921.1`、Miniflare `5.20260918.0-alpha`、workerd `1.20260918.1`。

## 实际执行与结果

以下命令在 WSL 中运行，结果来自本轮输出，未沿用旧 PR 验收描述。

| 位置 | 命令 | 最终结果 |
| --- | --- | --- |
| 根目录 | `npm ci` | 通过；最初因缺少根锁文件报 `EUSAGE`，修复后通过 |
| 根目录 | `npm run check` | Userscript 构建通过，70 测试通过 / 0 失败 / 0 跳过 |
| `worker/` | `npm ci --ignore-scripts` | 通过；未执行依赖安装脚本 |
| `worker/` | `npm run check` | 完整检查通过 |
| `worker/` | `npm run typecheck`（完整检查内） | `tsc --noEmit` 通过 |
| `worker/` | `npm test`（完整检查内） | 114 单元测试通过 / 0 失败 / 0 跳过 |
| `worker/` | `npm run test:runtime`（完整检查内） | 4 workerd / SQLite DO 集成测试通过 / 0 失败 / 0 跳过 |
| `worker/` | `npm run build`（集成检查内） | `wrangler deploy --dry-run --outdir .build` 通过；46.44 KiB / gzip 12.94 KiB |
| 根目录 | `node --check dist/hebut-chaoxing-seat-helper.user.js` | 通过 |
| 根目录 | `node --check worker/scripts/check-contract.mjs` | 通过 |
| 根目录 | `git diff --check` | 通过 |

最终合计 188 测试通过、0 失败。原始基线为 70 + 112 + 4 = 186，本轮增加 2 项缺陷回归测试。修复前专门执行的新回归测试曾实际失败（见下文），没有删除或弱化断言。

最后一次完整 Worker 检查设置 `WRANGLER_SEND_METRICS=false`，仍执行原 `npm run check`。可复核原始日志为 `worker/local-acceptance-20261014.log`，被现有 `*.log` 规则忽略。Wrangler 构建为 dry-run，不上传代码、不创建资源。集成测试所有上游请求均由本地 outboundService 拦截，使用明确标注的合成响应；真实 workerd / SQLite 通过不等于真实学校接口通过。

## 问题、根因与修复

1. 根目录没有 `package-lock.json`。即使没有第三方依赖，`npm ci` 仍要求锁文件。执行 `npm install --package-lock-only --ignore-scripts` 生成 lockfileVersion 3 的锁文件，未新增依赖、未修改 package.json，随后重新执行安装及 70 项检查通过。
2. Cron 明确拒绝后的自动重试丢失原定时授权截止时间。首次 `run(..., submitAt)` 只在当次调用检查授权；后续 `tick()` 调用 `reserveLocked()` 时未传入该时间，日志也未保存它。重启后仍可能在 15 分钟迟到窗口以外发起第二次提交。
   - 修复前回归：合成首次响应为“繁忙”，推进时钟 16 分钟，重建协调器后 tick；实际提交计数 2，断言期望 1，报 `AssertionError: 2 !== 1`。
   - 修复：Operation 增加可选 `submitAt`，首次 Cron 调用保存原时间，后续重试恢复该时间并复用原有提交前检查。保留首个截止时间，不用新重试延长授权。
   - 回归：重启后 16 分钟重试阻止写入并记录 `CRON_SUBMISSION_WINDOW_MISSED`；恰好 15 分钟仍可完成合成重试。跨天测试文件 19/19 通过，随后完整检查通过。
   - 保持 `account-v1`、DO 对象名和 SQLite 迁移标签不变；新增可选字段兼容旧日志。旧日志中没有截止时间的操作无法凭空恢复原 Cron 时间，未来启用写入前仍应审查旧未结束操作。本轮没有读取或修订生产日志。

## 持久化与保守处理复核

- 单个 `single-account-v1` DO 通过 SerialJournal 队列覆盖跨网络 await 的竞争；写前先持久化 `SUBMITTED_UNVERIFIED` 意图。
- 集成测试实测：SQLite DO 可读写；并发四请求仅一次合成提交；dispose / 新 workerd 后跨天归档及去重仍有效；丢失响应的未知意图重启后不因空查询而重提。
- 历史归档区分本地时段结束与服务器确认终态；SIGNED_IN 的本地过期归档不宣称服务器 COMPLETED。
- 状态码未映射、响应结构不符、请求失败、已知 ID 消失均保守处理。数字状态码不引用其他学校含义；签到窗口过去不推断退座或释放。
- Cron 日期锚定 scheduledTime 的上海次日，而非延迟唤醒时的当前日期；迟到超过 15 分钟停止授权。自动重约还要求已验证规则、明确资格布尔字段和预算，未知写意图保持阻塞。

## 部署前配置与剩余条件

本轮未改 `worker/wrangler.jsonc`、迁移、Cron、Secrets 或生产环境。

| 项目 | 本地配置检查 |
| --- | --- |
| 五个安全开关 | `WRITES_ENABLED` / `MONITOR_ENABLED` / `AUTO_REBOOK_ENABLED` / `REBOOK_RULES_VERIFIED` / `STATUS_PROFILE_VERIFIED` 均为字符串 `false` |
| DO binding | `SEAT_ACCOUNT` → `SeatAccount` |
| 迁移 | `v1-seat-account`，`new_sqlite_classes: [SeatAccount]`，未修改 |
| 预约 Cron | `29 14 * * *` = 上海 22:29 准备，代码将提交时间设为 22:30 |
| 监控 Cron | `*/1 * * * *`，入口被关闭开关阻止 |
| 目标 | ROOM_ID 3747、SEAT_NUM 216、08:30–22:00；为现有配置，未宣称本轮学校核验有效 |
| 签到窗口 | 默认提前/延后各 30 分钟，只作本地提示 |

Secrets 清单按源码和 README 核查名称：`CHAOOXING_COOKIE`、`ADMIN_TOKEN`、`CHAOOXING_RESERVE_PAGE_URL`、可选 `CHAOOXING_HALL_URL`、旧代 `FID_ENC` 或新代 `SEAT_ID` + `SEAT_ID_ENC`、经人工核验的 `STATUS_PROFILE_JSON`。当前 API_STYLE 为 seat，index 必须有 FID_ENC；示例文件不是完整配置证明。只确认本地 `.dev.vars` 文件存在且被忽略，没有打开其内容、核验值或查询线上 Secrets。不能据此确认线上五个开关或凭据状态。

启用生产功能前仍缺少：

- 本校真实、脱敏的 index/getstatus 样本，与官方界面显示的待签到、已签到状态逐条对应；监督、释放、完成状态仅在自然出现时取得，不能为验收制造事件。
- 实际 API 代际、字段路径、日期/时间格式、状态码含义和资格字段语义。`worker/test/contracts/` 目前仅有说明文件，现有 fixture 全部是合成数据。
- 学校关于重约资格、次数、起始时刻、剩余时段、监督/黑名单的正式规则及实际明确字段。无法验证则保持自动重约关闭。
- 提交响应及参数契约的合法历史脱敏证据；Cookie 有效期、人工验证要求、Worker 到学校网络可达性尚未验证。本轮不会为了取证发起真实写入。
- Cloudflare 账号、单账号绑定、现有 DO 迁移历史、配额和线上环境开关需在单独获准的部署阶段核对；本轮未访问生产运行态。
- 开发工具链安全告警：`npm audit --json` 报 4 项 high，涉及 miniflare、wrangler，以及传递依赖 sharp 0.35.4 / undici 7.29.0。均在 devDependencies 链，未作为 Worker 业务依赖打包。audit 提议的 Miniflare 修复包含大版本变化，不执行 `npm audit fix --force`。该告警仍未消除，不能宣布安全审查全部通过；工具链升级需独立验证 Miniflare API、SQLite 重启持久化和 Wrangler 兼容性。

## 最少浏览器人工操作

1. 今晚无需安装、替换、停用或操作当前正在运行的油猴脚本。诊断工作安排在预约完成后的安全时段；本轮没有控制浏览器或安装脚本。
2. 若现有页面已经提供“只读接口诊断”，在本人正常浏览官方预约列表时手动开启，观察正常 index/getstatus 响应，预览并确认导出去敏 JSON，同时记录官方界面显示的状态。没有诊断面板时，不立即更换脚本，另行安排隔离诊断。
3. 采集遗漏时，仅把 F12 → Network → Response 的 JSON 粘贴到已有本地脱敏面板；不提供 Headers、Cookie、请求体、HAR 或凭据。原始响应不要发到聊天或存入 Git。
4. 安全样本保存在被 Git 忽略的 `worker/private-diagnostics/`，人工核验映射后运行 `npm run check:contract -- private-diagnostics/sample.json private-diagnostics/profile.json`。解析通过仍不证明生产兼容。本轮没有真实样本，因此没有执行真实契约验收。
5. 正常到馆后本人完成官方现场扫码/签到；需要的状态证据来自随后正常浏览产生的读取响应。本轮不实现后台签到，也不制造退座或验证码绕过。

## 修改文件与执行边界

- `package-lock.json`：新增根锁文件。
- `worker/src/journal.ts`：可选 Cron 时间字段。
- `worker/src/lifecycle.ts`：保留并恢复重试授权时间。
- `worker/test/rollover.test.ts`：两个回归测试。
- `LOCAL_ACCEPTANCE_20261014.md`：本报告。

构建重生成仓库内 dist 文件，但与分支内容相同，没有产生 Git 修改。未更换正在运行的脚本，未调用真实学校接口、生产部署、合并、提交、推送、强推或清理生产 Durable Object 数据。测试使用独立临时 SQLite 数据，仅清理测试自己创建的临时目录。

## 2026-10-14 补充审查与收尾

以上段落保留首次验收的原始事实（188 项、4 项 high、未提交）。本节记录后续授权的审查、修复和本地提交，替代前文中旧日志尚待审查及安全告警未解决的当前状态判断，不改写历史结果。

### 旧日志漏洞实测与源码依据

漏洞真实存在于补充审查前的本地代码。SerialJournal.load() 仅补充 archives，保留缺失 submitAt 的 Operation；reserveLocked() 原先执行 `op.submitAt ??= submitAt`，tick() 的拒绝重试不传时间，提交前截止检查又只在 submitAt 已定义时生效。旧手动与 Cron 操作均没有来源标记，不能凭“没有时间”推断手动授权。

新增回归先用本地 Mock 实测：首次 Cron 收到明确“繁忙”拒绝，将持久化时间删除以模拟旧版日志，推进 16 分钟并重建协调器；实际模拟提交 2 次，预期 1 次，报 `AssertionError: 2 !== 1`。这确认的是旧日志恢复漏洞，不是生产预约证据。本轮没有读取真实 DO 日志，因此不能判断生产是否已有这样的记录。

最终修复：

- Operation 和 pendingRun 增加可选 `authorizationSource`，新操作明确记录 MANUAL / CRON / REBOOK。公开 HTTP /run 不接收用户传入的 submitAt；Cron 时间由原 scheduledTime 路径提供。
- lifecycle.ts 的 authorizationReason() 对旧日志只接受已有的有限 submitAt 作为 Cron 证据，添加 CRON 来源并保留原时间；未知来源、缺少 Cron 时间、NaN/Infinity 或不一致的来源/时间组合不授权写入。绝不按恢复时当前时间补授权。
- reserveLocked() 只为真正的新操作记录授权，已有 Operation 不由手动请求或新 Cron 时间覆盖。缺少证据返回 AUTHORIZATION_EVIDENCE_REQUIRED，并持久化 needsHuman 的 handoff；保留原 phase、attempts、结果及幂等键。
- pendingRun 在 tick、run 和跨天切换后崩溃恢复中都核验原证据；新手动请求或换日期不能覆盖旧待执行意图。过期 pendingRun 保留原授权和错误证据，不重发。
- 授权核验阻止新增写入，但既有 SUBMITTED_UNVERIFIED 仍可只读回查并按服务器明确记录确认；空响应、UNKNOWN、时间经过不能解锁重复提交。原归档、历史限制、并发串行队列和未知重约 ID 规则保留。
- 保持 account-v1、single-account-v1 和 v1-seat-account 不变；不清库、不重置操作、不更换 DO 标识。旧缺证据操作将保守阻塞，不能从本轮代码推断它们曾被手动授权。新明确手动操作仍受原 MAX_ATTEMPTS、退避和预约开始时间约束。

### 新增回归与持久化验证

新增 worker/test/authorization.test.ts 的 15 项测试：无来源无时间的旧 Cron、已知 CRON 来源却无时间、重启后授权丢失、15 分钟包含边界与 16 分钟过期、旧有限时间的加字段恢复、手动来源与 Cron 来源分离、手动请求不能降级既有 Cron、未知写意图仍不可重提、pendingRun 来源缺失、跨天切换后的崩溃窗口、待执行 Cron 时间边界及非有限时间拒绝。断言检查实际模拟提交次数、原提交计数、phase、时间、来源及持久化 handoff，不仅检查返回码。

新增 2 项真实 SQLite / workerd 集成测试：测试专用 seed 模块在独立临时 SQLite 写入旧 REJECTED 或 SUBMITTED_UNVERIFIED account-v1，停止原 workerd，再用真正业务 bundle 启动新的 workerd；监控与手动 /run 均不能制造新授权，实际合成 submit 调用为 0，旧 phase、attempts=1 和缺失字段保持。测试 seed 模块不进入业务 bundle，也不接触真实持久数据。原有 4 项集成测试仍覆盖一次实际合成提交后的丢响应恢复、跨天重启归档和并发单提交。

测试编写期间临时目录 seed 模块首次启动报 `can't use ".." to break out of starting directory`，根因是 Miniflare 模块根目录默认位于仓库，而脚本位于系统临时目录。测试 harness 明确设置 modulesRoot 为对应脚本目录后解决，没有删测试或弱化持久化断言。

### 依赖审计与修复

重新运行 `npm audit --json` 确认初始 4 项 high，依赖链为 Wrangler → Miniflare → sharp / undici。Miniflare 5.20260918.0-alpha 精确要求 sharp 0.35.4 / undici 7.29.0；audit 提议的 Miniflare 4.x 变更会改变主版本及持久化工具 API，本轮不采用，不运行 audit fix --force。

在 worker/package.json 对 Miniflare 的两条传递依赖添加精确 overrides，sharp 升至 0.35.5，undici 升至 7.29.1，更新 worker/package-lock.json。Sharp 平台二进制及 libvips 跟随补丁更新。保持 Miniflare 5.20260918.0-alpha、Wrangler 4.135.0、workerd 1.20260918.1 不变。Node 引擎要求分别为 >=20.9.0 / >=20.18.1，当前 WSL Node 24.19.0 满足。

sharp 告警涉及 Linux librsvg 的内存安全问题；undici 告警包括 WebSocket/解压拒绝服务、TLS 配置丢失、缓存 Cookie 泄漏等。开发机运行工具、代理或处理不可信响应时仍有风险，不能因 devDependencies 就认为风险为零。修复依据：[sharp 官方安全公告](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)、[undici TLS 公告](https://github.com/advisories/GHSA-w293-vg96-wgc3)、[undici 7.29.1 发布记录](https://github.com/nodejs/undici/releases/tag/v7.29.1)。

最终全依赖审计 0 vulnerabilities（high=0，critical=0）；`npm audit --omit=dev` 也通过。额外原生 smoke 实测 sharp 0.35.5 / librsvg 2.63.2 正常将内存中的合成 SVG 转为 2×2 PNG。业务源码不导入这些工具包，离线 bundle 检索没有 miniflare / sharp / undici / node_modules 引用；生产 Worker 使用 workerd fetch，其依赖面与 Node 开发工具不同。审计零告警不是未知漏洞或生产协议安全证明。

### 补充最终完整验收

测试环境仍为 WSL Ubuntu 24.04.4 / Node 24.19.0 / npm 11.17.0。

| 实际命令 | 结果 |
| --- | --- |
| 根目录 npm ci | 通过，锁文件与 package.json 一致 |
| 根目录 npm run check | 构建通过；70/70，0 失败、0 跳过 |
| worker/npm ci --ignore-scripts | 通过，未执行安装脚本 |
| worker/npm run check（WRANGLER_SEND_METRICS=false） | 类型检查、单元、dry-run、runtime 全部通过 |
| 完整检查内 tsc --noEmit | 通过 |
| 完整检查内单元测试 | 129/129，0 失败、0 跳过 |
| 完整检查内 workerd / SQLite 集成 | 6/6，0 失败、0 跳过 |
| Wrangler dry-run | 48.20 KiB / gzip 13.19 KiB；仅离线构建 |
| npm audit --json / npm audit --omit=dev | 全依赖与生产依赖均 0 已知告警 |
| git diff --check / git diff --cached --check | 提交前通过 |

最终合计 205 项通过（70 + 129 + 6），比上一轮 188 增加 17 项。本轮针对性失败记录、最终检查与审计日志均留在被 Git 忽略的 supplemental-*.log；测试 smoke 位于被忽略的 worker/.build/。日志、数据库、私人响应、HAR、Secrets 均不提交。

### 收尾、提交与生产阻塞

本地提交范围共 9 个文件：package-lock.json、worker/package.json、worker/package-lock.json、worker/src/journal.ts、worker/src/lifecycle.ts、worker/test/authorization.test.ts、worker/test/rollover.test.ts、worker/test/runtime.test.mjs、LOCAL_ACCEPTANCE_20261014.md。保留并一起提交上一轮根锁文件、Cron 修复和两个正确回归测试。

提交信息：`fix(worker): fail closed on missing persisted authorization`。最终 SHA 在本轮交付回复中给出，也可用 `git log -1 --format=%H -- LOCAL_ACCEPTANCE_20261014.md` 找到本报告所属提交，避免在提交内容内自引用其哈希。提交后核验开发分支工作区干净、相对远端只增加本地提交；不推送、不合并、不部署、不改变 PR 状态。

五个安全开关继续 false，wrangler.jsonc 的 Cron、绑定与迁移未改，未读取或修改生产 Secrets/DO。生产阻塞仍包括真实学校响应与状态语义、重约规则、合法历史提交契约、会话有效期及 Cloudflare 到学校的运行证据；旧授权证据不足的日志即使将来开启写入也会阻塞，不擅自清理恢复。

最少人工步骤仍为：预约完成后的安全时段，在已有诊断面板手动开启只读观察，正常查看官方预约状态；预览并导出去敏 index/getstatus JSON，同时注明官方界面状态。若漏采，仅将 Response JSON 输入已有本地脱敏面板，不提供 Cookie/Headers/HAR/请求体。安全样本放入 gitignored private-diagnostics，核验 profile 后离线 check:contract；本人到馆仍正常现场扫码。没有诊断面板时另行安排隔离诊断，不替换当前运行的油猴脚本。
