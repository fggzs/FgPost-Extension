import type { AccountInfo } from "~sync/common";

const PLATFORM_HOME = "https://channels.weixin.qq.com/platform";

/** 视频号助手登录后会写下的 Cookie，命中任意一个即视为已登录 */
const SESSION_COOKIES = ["sessionid", "wxuin", "bizuin"];

async function fetchProfile(): Promise<AccountInfo | null> {
  try {
    const response = await fetch("https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/finderuserinfo", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const data = payload?.data;
    const nickname = data?.finderNickname ?? data?.nickname;
    if (!nickname) return null;
    return {
      provider: "weixinchannel",
      accountId: String(data?.finderUsername ?? data?.username ?? nickname),
      username: String(nickname),
      avatarUrl: data?.headImgUrl,
      profileUrl: PLATFORM_HOME,
      extraData: payload,
    };
  } catch {
    return null;
  }
}

async function hasSessionCookie(): Promise<boolean> {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "channels.weixin.qq.com" });
    return cookies.some((cookie) => SESSION_COOKIES.includes(cookie.name));
  } catch {
    return false;
  }
}

export async function getWeixinChannelAccountInfo(): Promise<AccountInfo | null> {
  const profile = await fetchProfile();
  if (profile) return profile;

  // 接口结构可能变化，退回 Cookie 判断，避免已登录却显示未登录
  if (!(await hasSessionCookie())) return null;

  return {
    provider: "weixinchannel",
    accountId: "weixinchannel-logged-in",
    username: "视频号（已登录）",
    profileUrl: PLATFORM_HOME,
    extraData: {},
  };
}
