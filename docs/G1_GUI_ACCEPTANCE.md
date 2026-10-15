# G1 GUI 验收：PASS

2026-10-15，本机 Windows、Playwright 驱动真实 **Microsoft Edge 155.0.4283.45（headless）**。页面由 `worker/scripts/preview-control.mjs` 启动的真实 workerd/SQLite DO 提供，浏览器实际执行脚本、渲染并点击表单，没有 mock DOM 或用静态检查替代 GUI。

**最终 15/15 PASS，0 FAIL；原完整回归 75 + 217 + 8 = 300/300 PASS。** GUI 场景独立计数，重跑不累计。最终机器报告：[report.json](gui/2026-10-15T12-41-53-580Z/report.json)。

## 验收场景

| 项目 | 真实浏览器结果 |
| --- | --- |
| 页面加载、标题、CSP、未连接时保存禁用 | PASS |
| 错误管理令牌拒绝、合成令牌连接、输入框清空 | PASS |
| 候选排序按钮 216/215/217 → 215/216/217 | PASS |
| 添加“下午”模板、编辑非整点 14:30–20:30、选择默认模板 | PASS |
| 生效日期、启用、指定日期、星期、暂停日与单日覆盖 | PASS |
| 差异预览、保存 revision 1、不重新部署 | PASS |
| 保存后立即刷新目标摘要、清理旧差异 | PASS，修复前真实失败，见下文 |
| 刷新后令牌遗忘，重连恢复候选、模板、日期、星期、覆盖 | PASS |
| 两个真实标签页持有旧 revision，胜者保存、败者 409 且不覆盖 | PASS |
| 全局暂停、刷新后暂停仍在、恢复 | PASS |
| 只读预览缺少学校证据仍阻断 | PASS |
| 390×844 手机视口无横向溢出 | PASS |
| 手机星期复选框保持原生宽度 | PASS，修复 130px 拉伸 |
| 断开或错误重连清除可见旧状态，重连仍可读取保存配置 | PASS |
| 页面脚本错误、非本地请求、Worker 出站尝试 | 均为 0 |

## 发现的问题与修复

1. 原保存处理只更新编辑表单，目标摘要继续显示保存前的座位/时段，且旧差异 JSON 残留。先加入断言在原实现上复现失败，保留[失败报告](gui/2026-10-15T12-38-48-522Z/report.json)与[failure.png](gui/2026-10-15T12-38-48-522Z/failure.png)。修复为保存后读取最新缓存状态，并明确提示该 revision 已保存、再次修改需预览。
2. `.row input` 的 130px 宽度错误应用于星期 checkbox。截图确认手机布局松散，修复为原生 checkbox 宽度和紧凑 label，增加实际尺寸断言。
3. 原断开与失败重连只清部分隐藏字段，旧摘要仍可见。统一清除连接内存、可见状态/预览和保存资格；用真实断开、错误重连、正确重连验证。
4. 单日覆盖原显示随机模板 ID；改为模板名称，版本冲突/认证错误补充中文下一步，保留错误码便于排查。

首次基础脚本的 12 项通过只代表当时覆盖范围，截图复核后扩展用例捕获了第 1 项失败。所有中间报告保留，最终结论仅以最终报告和最终截图为依据。

## 最终截图

截图均来自真实 Edge fullPage screenshot；只有本地合成数据、空管理令牌框，不含学校个人信息。

- [页面加载](gui/2026-10-15T12-41-53-580Z/01-loaded.png)
- [保存后的模板、覆盖与最新目标摘要](gui/2026-10-15T12-41-53-580Z/02-plan-saved.png)
- [两个标签页的版本冲突](gui/2026-10-15T12-41-53-580Z/03-version-conflict.png)
- [全局暂停](gui/2026-10-15T12-41-53-580Z/04-paused.png)
- [手机布局](gui/2026-10-15T12-41-53-580Z/05-mobile.png)

## 离线与状态保护

预览仅绑定 127.0.0.1:18765，使用公开合成令牌 LOCAL_PREVIEW_ONLY，WRITES_ENABLED/STATUS_PROFILE_VERIFIED=false，不加载 `.dev.vars`、真实 Cookie 或用户 Edge profile。浏览器拦截所有非预览 origin 请求，Worker 出站也在本地返回 503 并计数；最终两层尝试记录均为 0。没有点真实执行、到馆外链或通知授权按钮，没有学校请求、真实预约、Cloudflare 部署或 PR 合并。

每轮只创建自己拥有的临时预览实例，遇端口已占用直接拒绝，不复用/停止已有服务。只关闭本轮浏览器和预览进程，不删除或重置任何已有持久状态。刷新验证的是同一 workerd 运行期间 DO 状态的持续保存，不声称进程重启保存；DO 跨重启另由原 8 项 SQLite 集成测试覆盖。

## 复现

从 worker 目录先运行 `npm run build`（dry-run），然后：

```powershell
# 指向本机已存在的 Playwright 包，不新增仓库依赖、不下载浏览器。
$env:PLAYWRIGHT_MODULE_PATH = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
node scripts/gui-acceptance.mjs
```

若 Playwright 可由当前 Node 直接解析，可省略变量；机器须已有 Edge。报告和截图使用新的 UTC runId 目录，不覆盖历史。预览正常通过 IPC 关闭；没有生产管理或重置端点。

G1 只证明本地控制页的这些真实浏览器交互通过。学校正式规则、真实预约/签到 E1–E5、系统通知许可及投递不在本次 GUI 验收范围，保持原门禁。
