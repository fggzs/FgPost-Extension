/**
 * 对外展示的文案清洗。
 * 前端只告知用户“账号/登录”本身，不暴露背后使用的授权服务提供方。
 * 注意：这里用转义写品牌名，避免打包产物里出现可直接搜索的字面量。
 */
export function publicMessage(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/[\u98de\u9e1f]/g, "")
    .replace(/feiniao/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
