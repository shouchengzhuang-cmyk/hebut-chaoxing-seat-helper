# 本轮测试矩阵

日期：2026-10-15；Windows / PowerShell，Node v24.15.0、npm 11.12.1，锁定 Wrangler 4.135.0。所有学校数据均合成，未进行真实学校请求或部署。

## 接管与基线

工作区干净，本地 fffab2b 比远端落后 9 提交；git fetch 后 --ff-only 同步到 8d850226f2341fc39646b66a3faab42ecb62d3e9。原 PR #1 OPEN/Draft，接管时远端两个 job 均 SUCCESS。未 reset、未新建 PR、未合并。

本轮根目录 `npm ci`、`npm run check` 首次运行 70/70。Worker 首次安装在沙箱遇 npm “Exit handler never called”，按原锁文件在获准环境重装后审计 0 vulnerabilities。初次既有 Worker 测试集 151/152：Windows 把 file URL pathname 解析为 `D:\D:\...`；已改 fileURLToPath。该失败没有伪称基线全绿，运行未继续到原 runtime 步骤。

## 最终命令与结果

| 命令 | 结果 | 范围 |
| --- | --- | --- |
| 根 npm ci | PASS | 原锁文件，无新增依赖 |
| 根 npm run check | PASS 75/75，0 fail | build + Node tests |
| worker npm ci --ignore-scripts | PASS | 原锁文件，无生命周期脚本 |
| worker npm run check | PASS 217 单元 + 8 集成，0 fail | 类型检查、单元、dry-run、workerd/SQLite |
| worker npm run typecheck | PASS | tsc --noEmit |
| worker npm run build | PASS | wrangler deploy --dry-run；不是部署 |
| node --check dist/hebut-chaoxing-seat-helper.user.js | PASS | 生成脚本语法 |
| 构建后 git diff --exit-code -- dist/... | PASS | 与已提交产物一致；CI 同样检查 |
| git diff --check / git diff --cached --check | PASS | 无 whitespace 错误 |
| GitHub Actions 原 workflow | 见本轮工作记录的最终 HEAD 核验 | push 与 PR 检查，无学校网络/部署 |

总计 **300 项测试**：75 + 217 + 8。定向检查与重跑不重复累计。完整最终命令在提交前重新运行，摘要保留于工作记录；临时 .log 不进入 Git。

## 行为覆盖

| 验收点 | 结论 | 证据/说明 |
| --- | --- | --- |
| 原 journal 增量迁移、未知 schema 拒绝 | PASS | plans、authorization、rollover；保留旧不确定意图 |
| DO SQLite 重启持久化 | PASS | runtime：dispose/new workerd + resourcePersistencePath |
| 配置 revision CAS、存储失败原子性 | PASS | plans：单赢家、put 失败旧状态不变；runtime CAS/restart |
| 多模板、单日覆盖、三候选重排数据 | PASS | plans：216/215/217 与 14:00–20:00 解析 |
| 日期、星期、暂停日、生效版本、跨年 | PASS | plans/time/checkin-window；跨午夜预约拒绝 |
| 房间/开放时间、提前天数、网格、有效期 | PASS | plans：缺证据、失效/重叠规则拒绝；未用别校规则 |
| 当前提交冻结、未来修改不改变旧目标 | PASS | plans、worker-ownership；同一外层串行队列 |
| 只读跟踪后未提交目标仍可修改 | PASS | plans 专项；改后重新查学校 |
| 全局暂停、保留未知日志 | PASS | plans；pause 不取消预约 |
| Cron 与手工并发、重复按钮 | PASS | plans + runtime：仅一个 submit |
| 两端竞争 | PASS 代码门禁 | 油猴无协调授权拒绝 LIVE；Worker 为唯一写端，旧安装需停用 |
| 放号规则变化、延迟 Cron、过期不补 | PASS | plans、rollover、authorization；分钟调度与旧窗口限制 |
| 提交前资格再读、资格缺失或撤销 | PASS | plans：两次读取，零写入 |
| 正向匹配成功、错 ID/房间/座位/日期 | PASS | reservation/status/contract 与 plans |
| 网络掉线、429/5xx、丢 POST 回应 | PASS | plans/runtime：持久未知，仅回读、不切候选 |
| Cookie 失效、验证码、监督、限流 | PASS | reservation/lifecycle/plans：停止自动重试/切换 |
| 明确冲突才推进、60秒退避与 cursor 重启 | PASS | plans：单独核验 code 契约；无证据不推进 |
| 未知状态、空列表不当作释放 | PASS | status/contract/lifecycle/rollover |
| 释放重约门禁、预算、再次核验 | PASS | 原 lifecycle + plans 新专项，默认开关关闭 |
| 签到成功/未知/监督/终态/重复/重启 | PASS | CheckinCoordinator/plans；时间不合成成功，未实现签到写 transport |
| 过期签到成功缓存不覆盖 UNKNOWN | PASS | plans 专项；新日期清除旧签到实例 |
| 提醒提前/临近截止、跨标签/重启去重 | PASS | plans：持久领取两阶段；不承诺页面关闭送达 |
| 跨站、无 token、URL token、超长/非法 JSON | PASS | management + runtime，16KiB 流读取 |
| 凭据重定向、URL 白名单 | PASS | 既有 reservation/routes/status；控制页只连同源 |
| 原始状态/预约 ID/响应文本不泄露 | PASS | management、worker-ownership、diagnostics |
| 同步 dist、版本一致 | PASS | build 读取 package.version；CI stale-dist 检查 |
| 控制页 JS 语法、CSP、字段表单 | PASS 静态检查 | management；不等于真实 DOM 点击/布局验收 |
| 控制页真实浏览器布局与完整体验脚本 | BLOCKED G1 | computer-use 浏览器控制授权超时，没有伪造截图 |
| 本校生产状态映射与资格、窗口 | BLOCKED E1–E4 | 缺真实 UI 对照及规则证据，全部写能力保留门禁 |
| 真实预约 + 真实签到回执 | BLOCKED E5 | 未登录学校、未部署、未修改真实座位状态 |
| 无人值守签到 / 自动取消 | BLOCKED | 没有正式允许契约，没有猜测写接口 |
| 生产性能、账号实际额度 | BLOCKED E5 | 未部署，不宣称模拟数字是线上计量 |

workerd 在沙箱曾因 GetFinalPathNameByHandleW 拒绝访问无法启动，获准本地执行后可测。一次 Miniflare 随机端口命中 undici bad port，测试固定使用 31000 起的独立端口后通过。没有用 skip 或模拟 SQLite 掩盖这些问题。
