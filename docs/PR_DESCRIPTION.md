# 已批准的 PR #1 更新内容

推送目标：`origin` / `feat/worker-seat-lifecycle-20261013`，对应 `shouchengzhuang-cmyk/hebut-chaoxing-seat-helper` 的现有 PR #1。只作正常推送并更新标题与说明，保持 Draft，不合并、不强推、不部署。

本轮工程提交：14efa96、6c96d14、88e8067。随后的记录提交只补充测试/审批状态和此说明。

用户已明确批准正常推送并更新原 Draft PR #1，1939e9a 已推送且 push/PR 两组 CI 全绿；后续仅补发布记录。

建议标题：运行期预约计划、持久协调与现场签到状态闭环

---

固定部署参数无法方便切换模板，独立浏览器与 Worker 也缺少共同写入边界。本 PR 继续原生命周期工程，加入同源 `/control` 控制页和受保护运行期计划 API：房间、候选优先级、多个时段模板、日期/星期/暂停/单日覆盖、revision CAS 与未来生效审计均持久保存在原账号 DO。无需改源码或重部署即可保存新计划。

Worker 成为自动预约唯一写端；油猴保留官方页面模拟与主动脱敏诊断，缺持久协调授权时拒绝 LIVE。提交前二次读取资格，写前持久意图，未知响应只回读，按本校核验规则计算开放时刻；精确冲突契约满足后才按候选推进并退避。原 DO 身份、journal 与未知授权记录不重置。

独立 CheckinCoordinator 只认可已核验的官方 SIGNED_IN 记录。本人完成必要的真实现场验证后回读；不存在无人值守签到、取消或绕过位置/二维码的写接口。增加全局暂停、两阶段提醒领取持久去重、状态脱敏、旧签到缓存保护和完整发布/外部核验文档。

验证：根 npm run check 75 项；Worker npm run check 包括类型、217 单元、dry-run、8 项真实 workerd/SQLite 集成，共 300 项、0 失败；dist 一致、语法与 diff 检查通过。未新增依赖、未修改生产开关或 migration tag。

G1 后续已通过：本机真实 Edge 155.0.4283.45 headless + Playwright，使用 preview-control.mjs 完全离线预览，15 项 GUI 场景全部 PASS，页面脚本错误/非本地请求/Worker 出站尝试均为 0。覆盖加载、令牌、候选排序、非整点模板、日期与星期/暂停/覆盖、保存、双标签版本冲突、全局暂停、刷新持久化及手机布局。保存后陈旧摘要、旧差异、断开连接残留与 checkbox 布局已修复；修复前失败报告、最终通过报告及真实截图见 docs/G1_GUI_ACCEPTANCE.md。已重新运行完整 300 项，全部通过。

未部署，未执行真实学校预约、签到或取消，未删除/重置已有持久状态。学校状态、资格、开放/时段、冲突与签到正式规则仍需本人正常登录/到馆提供证据；E1–E5 未核验能力继续门禁关闭。系统通知许可与实际投递不在本次 G1 范围。

详见 docs/TEST_MATRIX.md、docs/EXTERNAL_VERIFICATION.md、docs/RELEASE_CHECKLIST.md、docs/ARCHITECTURE.md。保持 Draft，不合并。
