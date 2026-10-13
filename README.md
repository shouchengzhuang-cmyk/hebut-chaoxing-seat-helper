# HEBUT Chaoxing Seat Helper

一个在超星**已正常登录的座位预约页面内**运行的 Tampermonkey Userscript。它不保存账号密码、不导出 Cookie、不复刻 `enc`、不直接请求预约接口，也不会识别或绕过验证码。

唯一的 LIVE 提交动作是页面 Vue 实例的 `vm.submit()`；Cookie、签名、风控、验证码和官方 POST 全部仍由超星页面自己处理。

## 当前验证边界

- **已由代码和测试验证：** 状态机、上海时区目标日期、开放时刻计算、单提交锁、目标日 iframe gate 重试、iframe-only Dry Run/LIVE 提交路径、明确座位冲突才 fallback、模糊响应停止、日志脱敏、iframe Window realm 的 XHR/fetch 观察器、用户脚本单文件构建。
- **已由当前页面实测事实提供：** `roomId=3747` 页面可取得 `.order.__vue__`，并存在 `chosedDay`、`chosedSeatNum`、`chosedTimeInfo`、`seatConfig`、`submit()`；当前房间规则 baseline 是提前 1 天、`22:30` 开放。
- **已由真实浏览器验证：** 当前日 iframe 可加载、同源可访问、Vue ready、`vm.submit` 存在且父页面未被影响；开放前的目标日 iframe 会被服务端重定向到 `reserve/error`，并正确识别为 `gate=CLOSED`。
- **仍需今晚 OPEN 现场验证（NEEDS_BROWSER_VERIFICATION）：** 开放瞬间目标日 iframe 是否保持在 select 页面、该 iframe 内的官方 `vm.submit()` 实际响应文案/字段、验证码/风控 overlay 后的人工操作与继续观察表现，以及 HTTP `Date` 是否可读。它们不会在本地测试中被伪造成已确认。

## 安装

1. 安装 Tampermonkey。
2. 在项目目录执行：

   ```powershell
   npm run build
   ```

3. 打开 [dist/hebut-chaoxing-seat-helper.user.js](dist/hebut-chaoxing-seat-helper.user.js)，由 Tampermonkey 安装。
4. 在学习通中**正常人工登录**，打开与下列形式相同的选座页：

   ```text
   https://office.chaoxing.com/front/third/apps/seat/select?deptIdEnc=...&id=3747&...
   ```

页面右下角会出现深色面板，并在控制台输出 `[HEBUT-SEAT] ready`。当前版本为 **1.1.0**。

## 默认首次配置

首次默认值是：

```text
roomId:       3747
seatPriority: 216
time:         08:00 - 22:00
fireDelayMs:  100
mode:         dry-run
autoArm:      false
```

在面板设置区可修改座位优先级（如 `216,215,217`）、时间、延迟和模式；它们保存在同源 `localStorage`。也可在控制台更新配置：

```javascript
HEBUT_SEAT.config({
  seatPriority: ['216', '215', '217'],
  startTime: '08:00',
  endTime: '22:00',
  mode: 'dry-run'
})
```

不会保存账号、密码、Cookie、Authorization、captcha、`wyToken` 或 `enc`。

## 长期自动预约

1. 白天打开 `roomId=3747` 的正常选座页面，确认学习通登录态有效。
2. 点击“立即检查”，核对明天、216、`08:00 - 22:00`、房间规则和时间源；`OPEN_RULE_CHANGED` 时以页面真实规则为准。
3. 首次先保持 `DRY RUN` 并开启“自动预约”。它会等待或在已开放时立即补跑完整 iframe 流程，输出 `IFRAME_DRY_RUN_WOULD_SUBMIT`，绝不调用任何 `vm.submit()`。
4. 确认 Dry Run 正常后，手动切换为 **LIVE** 并保存设置。只有 `autoArm=true` 与 `mode=live` 同时成立时才会真实提交。
5. 页面可以后台挂着。开放前由 Scheduler 等待；后台延迟唤醒、focus、visibility 恢复或已过开放时间时，DailyReservationController 会重新校时并补做 reconciliation。父页 Vue 永不用于提交。
6. 成功后当前 targetDay 写入成功账本；跨过上海自然日后会创建下一轮 targetDay 生命周期，无需刷新或再次武装。

若 iframe 内出现验证码/风控，脚本会进入 `NEEDS_HUMAN`、将该目标日 iframe 显示为全屏官方页面、停止自动重试和换座；请直接在 iframe 中人工完成验证。成功只会在 iframe Window realm 的提交响应或 iframe Vue 的 `submitsuccess/seatReserve` 与目标匹配后标为 `SUCCESS`。

## 绝对不要做

- 不要在两个标签页同时武装同一日期；脚本有 Web Locks 和 localStorage fallback，但单标签仍是最佳实践。
- 等待期间不要刷新、跳转、退出登录、切换到其他房间或手动改动日期/座位/时间。
- 不要在验证码出现后让脚本自动重新提交；它会停下来，人工处理即可。
- 不要把产物部署到 GitHub Actions、云服务器或第三方抢座服务。
- 不要把任何凭据粘贴到控制台、脚本设置或 Issue。

## 控制台 API

```javascript
HEBUT_SEAT.probe()
HEBUT_SEAT.dryRun()
HEBUT_SEAT.arm()
HEBUT_SEAT.disarm()
HEBUT_SEAT.stop()
HEBUT_SEAT.status()
HEBUT_SEAT.downloadLog()
HEBUT_SEAT.downloadDiagnose()
HEBUT_SEAT.resetForDate('2026-09-21')
HEBUT_SEAT.resetAttemptForDate('2026-09-21')
HEBUT_SEAT.enableNotifications()
await HEBUT_SEAT.debug.testIframeLoader()
await HEBUT_SEAT.debug.testTargetDayGate()
```

`HEBUT_SEAT.debug.shadowSubmitProbe()` 只供开发诊断：它会临时拦截一次官方提交 transport，在发出前记录 method/pathname/字段名这一层的形状并阻断该请求。它不是日常功能，绝不在 LIVE/Dry Run 自动调用。

`testIframeLoader()` 会在屏幕外创建、加载并销毁一个当前选座页的同源 iframe，只读返回 `finalUrl`、`loadMs`、`day`、`.order.__vue__`、`submitIsFunction`、房间字段和 `seatConfig`。`testTargetDayGate()` 仅把 iframe URL 的 `day` 查询参数改为上海时区的明天：跳转到 `/front/apps/reserve/error/...` 时返回 `gate: 'CLOSED'`，停留在目标日期 select 页面时才等待 Vue 兼容性。两者都不会调用 `vm.submit()`、改父页面 URL 或写入预约状态；iframe 始终在 `finally` 中销毁。若日志或返回 `error` 为 `FRAME_BUSTING_DETECTED`、`IFRAME_CROSS_ORIGIN` 或 `IFRAME_VUE_TIMEOUT`，不要接入 LIVE，保留当前单页路径继续诊断。

注意：iframe 中的请求不属于顶层窗口的 `SubmitObserver` 覆盖范围。后续若确需观察 iframe 内请求，必须显式使用 `new SubmitObserver({ windowRef: frame.contentWindow })`；本版本未安装该观察器，也未把 iframe 接入预约状态机。

## 调度和安全设计

- 目标日期一律由 `Asia/Shanghai` 日历计算；不依赖电脑当前时区。
- `reserveBeforeDay` 和 `reserveBeforeTime` 每次 Probe 从页面 `seatConfig` 重新读取，并反推开放时刻；`22:30` 只是提醒 baseline，不是永久硬编码规则。
- 校时先探测 `window.currentServerTime`、`vm.currentServerTime` 等页面来源；不可用才对同源当前页面发送三次 `HEAD`。HTTP `Date` 常为秒级，UI 会显示至少约 ±500ms 的不确定性；本机 fallback 或不确定性大于 fire delay 时显示 `TIME UNCERTAIN`。
- 校时完成后用 `performance.now()` 单调时钟作为锚点倒计时，避免运行期间系统时间/NTP 跳变。
- 最后 1 秒前台页使用 `requestAnimationFrame`；后台标签会有明确提示，但浏览器节流仍可能造成延迟。
- LIVE 在调用 `vm.submit()` **之前**持久写入按 `targetDay` 计的 `SUBMITTED_UNVERIFIED` 账本。刷新、停止、模糊响应和会话失效不会清除；未知服务端文案也按 `AMBIGUOUS` 处理。仅明确匹配的 `DEFINITIVE_FAILURE` 或 `resetAttemptForDate()` 能解除该日期的提交阻断。
- LIVE 只允许一个 in-flight official submit。`navigator.locks` 可用时用同源独占锁，并辅以每 20 秒续租的 localStorage heartbeat lease；人工验证观察最长 10 分钟也不会在 60 秒后失锁。
- 不明响应、超时、网络中断和不可解析结果全归为 `AMBIGUOUS`，进入人工处理，**绝不直接换座**。
- 只有明确 `GATE_NOT_OPEN` 才按 `[180,260,400]ms` 串行短重试；只有明确 `SEAT_CONFLICT` 才按 seat priority 切换。所有请求合计受 `maxTotalSubmits` 限制。

## 构建与测试

```powershell
npm run build
npm test
npm run check
```

`npm run check` 会构建单文件 Userscript 并运行 51 项、零真实网络访问的模拟单元测试。测试通过不等于已完成真实座位预约；真实页面行为必须在 Probe、iframe Dry Run 和一次由用户在场的 iframe LIVE 运行中分别确认。

## 可选的本地只读诊断

开发分支油猴面板新增“只读接口诊断（默认关闭）”。官方大厅/码页仅显示诊断，不启动预约引擎。在当前页主动开启后正常查看预约或切换日期；它只观察index/getstatus响应，不发额外请求，整页刷新后自动关闭。

点“预览并导出诊断JSON”，检查替代编号和日期，然后确认下载。姓名、UID、Cookie、Token、enc等字段不导出；样本不上传、不写本地持久存储。窗口内最多保留10份脱敏样本。采集不到时用面板的手工粘贴工具：仅复制开发者工具Network里的Response JSON，不复制Headers或HAR；导入后原文被清除。

导出的编号和日期是替代值，不能用于真实请求。请同时说明当时官方页面显示“待签到/已签到/监督”等哪个状态；不要在仓库或PR上传私人诊断数据。默认接口契约未验证，后续离线流程见worker/test/contracts/README.md。旧downloadDiagnose API现在也进入白名单预览确认，不再直接下载自由格式日志。原预约设置、提交观察和锁逻辑保持不变。
