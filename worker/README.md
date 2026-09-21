# Chaoxing Seat Reserver Worker

一个单用户、单座位的 Cloudflare Workers MVP：每天北京时间 22:29 由 Cron 启动，预取当天页面的动态 `submit_enc`，在理论 22:30:00 提交次日的预约。它只调用预约接口；不实现签到、定位、验证码绕过或自动登录。

默认预约：河北工业大学北辰校区图书馆 2F 二楼自习室，`roomId=3747`、座位 `216`、`08:30-22:00`。可在 `wrangler.jsonc` 的非敏感 `vars` 中调整。

## 安装与本地检查

```powershell
cd worker
npm install
npm run typecheck
npm test
```

`npm test` 会验证两个 `enc` Golden Vector、不同 HTML 属性顺序、缺失 token、上海跨月/跨年日期、健康检查、`/run` 鉴权及 dry-run 不提交。测试使用虚构 Cookie 文本，绝不访问超星。

## 配置 Secrets

下列值都不能提交到 Git，也不要粘贴进日志：

```powershell
npx wrangler secret put CHAOOXING_COOKIE
npx wrangler secret put CHAOOXING_RESERVE_PAGE_URL
npx wrangler secret put ADMIN_TOKEN
```

`CHAOOXING_RESERVE_PAGE_URL` 必须是已认证后能返回 `<input id="submit_enc" ...>` 的真实选座页 URL。Worker 每次预约前都会重新请求它；如响应是登录页、401/403、重定向或没有 `submit_enc`，会以 `AUTH_EXPIRED` 或 `AUTH_OR_PAGE_INVALID` 停止。

本地可复制 `.dev.vars.example` 为 `.dev.vars` 后填入自己的临时值；该文件已被忽略。

## 首次 dry-run

启动本地 Worker（Cron 测试模式）：

```powershell
npx wrangler dev --test-scheduled
```

另开一个终端执行受保护的 dry-run：

```powershell
curl.exe -X POST http://127.0.0.1:8787/run -H "Authorization: Bearer <ADMIN_TOKEN>"
```

预期只返回 `tokenFound`、目标日期、座位和 `encGenerated`，不会显示或提交 Cookie、`submit_enc`、`enc`。确认无误后，`POST /run?commit=1` 才会真的提交。测试 Cron 时可用 Wrangler 的 scheduled-event 控制台入口；该入口应只在本地配合虚构/已授权的测试凭据使用。

## 部署

```powershell
npx wrangler deploy
```

Cron `29 14 * * *` 以 UTC 执行，对应北京时间 22:29。Worker 在 22:30 前约 5 秒取得最新 token，等待至目标时刻后串行提交；仅在网络异常、5xx 或短暂繁忙时按 `300/700/1500/3000 ms` 最多重试，绝不并发或无限重试。

成功需要 `success === true` 且返回的房间、座位、日期匹配。若提示已预约，会查询预约信息并仅在同日同座匹配时以 `ALREADY_RESERVED` 作为幂等成功；若需要验证码/网易验证/安全验证，则输出 `MANUAL_VERIFICATION_REQUIRED` 并停止。
