import { officialUrl } from "./seat-api.ts";
import type { Env } from "./types.ts";
export function arrivalEntry(env: Env): { url: string; instruction: string } {
  return { url: officialUrl(env.CHAOOXING_HALL_URL, "hall", env), instruction: "到馆后在官方页面扫描现场二维码并完成验证，再调用监测接口确认签到状态。" };
}
