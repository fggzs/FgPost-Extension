import type { AccountInfo } from "~sync/common";

const CP_HOME = "https://cp.kuaishou.com";

/** 快手创作者中心的会话 Cookie，命中任意一个即视为已登录 */
const SESSION_COOKIES = ["kuaishou.server.web_st", "kuaishou.web.cp.api_st", "kuaishou.server.web_ph"];

async function fetchProfile(): Promise<AccountInfo | null> {
  try {
    const response = await fetch("https://cp.kuaishou.com/rest/cp/creator/pc/user/info", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const user = payload?.data;
    if (!user?.userName) return null;
    return {
      provider: "kuaishou",
      accountId: String(user.userId ?? user.userName),
      username: String(user.userName),
      avatarUrl: user.headUrl,
      profileUrl: CP_HOME,
      extraData: payload,
    };
  } catch {
    return null;
  }
}

async function hasSessionCookie(): Promise<boolean> {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "kuaishou.com" });
    return cookies.some((cookie) => SESSION_COOKIES.includes(cookie.name));
  } catch {
    return false;
  }
}

export async function getKuaishouAccountInfo(): Promise<AccountInfo | null> {
  const profile = await fetchProfile();
  if (profile) return profile;

  // 接口结构可能变化，退回 Cookie 判断，避免已登录却显示未登录
  if (!(await hasSessionCookie())) return null;

  return {
    provider: "kuaishou",
    accountId: "kuaishou-logged-in",
    username: "快手账号（已登录）",
    profileUrl: CP_HOME,
    extraData: {},
  };
}
