/**
 * 平台显示白名单
 *
 * 当前只开放：抖音、Bilibili、小红书、快手、视频号。
 * 其余平台暂时隐藏（代码保留），需要恢复时把对应平台名 / 账号 key 加回下面的集合即可。
 */
export const ENABLED_PLATFORM_NAMES = new Set<string>([
  // 抖音
  "DYNAMIC_DOUYIN",
  "VIDEO_DOUYIN",
  // Bilibili
  "DYNAMIC_BILIBILI",
  "VIDEO_BILIBILI",
  "ARTICLE_BILIBILI",
  // 小红书
  "DYNAMIC_REDNOTE",
  "VIDEO_REDNOTE",
  // 快手
  "DYNAMIC_KUAISHOU",
  "VIDEO_KUAISHOU",
  // 视频号
  "DYNAMIC_WEIXINCHANNEL",
  "VIDEO_WEIXINCHANNEL",
]);

/** 账号刷新白名单（按 accountKey 过滤，与平台白名单保持一致） */
export const ENABLED_ACCOUNT_KEYS = new Set<string>(["douyin", "bilibili", "rednote", "kuaishou", "weixinchannel"]);

export function isPlatformEnabled(name: string): boolean {
  return ENABLED_PLATFORM_NAMES.has(name);
}

export function isAccountEnabled(accountKey: string): boolean {
  return ENABLED_ACCOUNT_KEYS.has(accountKey);
}
