import { Storage } from "@plasmohq/storage";

import {
  type FeiniaoSession,
  type FeiniaoUser,
  fetchVipExpireAt,
  formatVipTime,
  heartbeat,
  initSession,
  loginUser,
  logoutUser,
  registerUser,
} from "~utils/feiniao";

const storage = new Storage({ area: "local" });

const SESSION_KEY = "feiniao_session";
const USER_KEY = "feiniao_user";
const MACHINE_KEY = "feiniao_machine";

/** 在线授权校验结果的缓存时长：通过 60 秒，失败 15 秒（避免每次点击都打接口，又不让失败态长期滞留） */
const AUTH_OK_CACHE_MS = 60 * 1000;
const AUTH_FAIL_CACHE_MS = 15 * 1000;

export interface AuthorizeResult {
  ok: boolean;
  message: string;
  user?: FeiniaoUser;
}

let authCache: { until: number; result: AuthorizeResult } | null = null;

/** 浏览器环境下的设备码：首次生成后固定，等价于 SDK 的 machineCode */
export async function getMachineCode(): Promise<string> {
  let machineCode = await storage.get<string>(MACHINE_KEY);
  if (!machineCode) {
    machineCode = `FG-${crypto.randomUUID()}`;
    await storage.set(MACHINE_KEY, machineCode);
  }
  return machineCode;
}

export async function getSession(forceRefresh = false): Promise<FeiniaoSession> {
  if (!forceRefresh) {
    const cached = await storage.get<FeiniaoSession>(SESSION_KEY);
    if (cached?.token && cached?.cryptoKeyAes) {
      return cached;
    }
  }
  const session = await initSession();
  await storage.set(SESSION_KEY, session);
  return session;
}

export async function getStoredUser(): Promise<FeiniaoUser | null> {
  return (await storage.get<FeiniaoUser>(USER_KEY)) ?? null;
}

async function clearSession(): Promise<void> {
  await storage.remove(SESSION_KEY);
  await storage.remove(USER_KEY);
  authCache = null;
}

async function doLogin(username: string, password: string): Promise<FeiniaoUser> {
  const machineCode = await getMachineCode();
  let session = await getSession();
  let result: { username: string; vipTime: string; vipExpireAt: number };
  try {
    result = await loginUser(session, username, password, machineCode);
  } catch (_error) {
    // Token 可能已过期，换一枚新 Token 再试一次
    session = await getSession(true);
    result = await loginUser(session, username, password, machineCode);
  }
  const user: FeiniaoUser = {
    username: result.username,
    vipTime: result.vipTime,
    vipExpireAt: result.vipExpireAt,
    loginAt: Date.now(),
  };
  await storage.set(USER_KEY, user);
  authCache = null;
  return user;
}

async function doRegister(username: string, password: string): Promise<void> {
  const machineCode = await getMachineCode();
  // 注册固定使用全新会话：本地缓存的旧 Token 会让服务端按过期会话解密，返回加密相关错误
  let session = await getSession(true);
  try {
    await registerUser(session, username, password, machineCode);
  } catch (_error) {
    session = await getSession(true);
    await registerUser(session, username, password, machineCode);
  }
}

async function doLogout(): Promise<void> {
  const session = await storage.get<FeiniaoSession>(SESSION_KEY);
  if (session?.token) {
    try {
      await logoutUser(session);
    } catch (error) {
      console.warn("授权服务退出登录接口失败，已清理本地状态", error);
    }
  }
  await clearSession();
}

async function doHeartbeat(): Promise<string> {
  const session = await getSession();
  try {
    return await heartbeat(session);
  } catch (_error) {
    const fresh = await getSession(true);
    return await heartbeat(fresh);
  }
}

async function doFetchVipExpireAt(): Promise<number> {
  const session = await getSession();
  try {
    return await fetchVipExpireAt(session);
  } catch {
    const fresh = await getSession(true);
    return await fetchVipExpireAt(fresh);
  }
}

function rememberAuth(result: AuthorizeResult): AuthorizeResult {
  authCache = { until: Date.now() + (result.ok ? AUTH_OK_CACHE_MS : AUTH_FAIL_CACHE_MS), result };
  return result;
}

/**
 * 发布前置授权校验：本地登录态 + 在线心跳 + 会员到期时间。
 * 所有发布入口必须先经过这里，任一项不通过都拒绝发布。
 */
export async function ensureAuthorized(force = false): Promise<AuthorizeResult> {
  try {
    return await runAuthCheck(force);
  } catch (error) {
    return rememberAuth({
      ok: false,
      message: `授权校验异常：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function runAuthCheck(force: boolean): Promise<AuthorizeResult> {
  if (!force && authCache && authCache.until > Date.now()) {
    return authCache.result;
  }

  const user = await getStoredUser();
  if (!user) {
    return rememberAuth({ ok: false, message: "未登录，请先登录后再发布" });
  }

  const now = Date.now();
  if (user.vipExpireAt && user.vipExpireAt * 1000 <= now) {
    return rememberAuth({ ok: false, message: "会员已过期，请续费后再发布", user });
  }

  try {
    await doHeartbeat();
  } catch (error) {
    return rememberAuth({
      ok: false,
      message: `在线校验失败：${error instanceof Error ? error.message : String(error)}`,
      user,
    });
  }

  // 到期时间以服务端为准；部分账号可能查不到记录，查询失败时沿用本地记录，不阻断正常用户
  let vipExpireAt = user.vipExpireAt ?? 0;
  try {
    const freshVipExpireAt = await doFetchVipExpireAt();
    if (freshVipExpireAt > 0) {
      vipExpireAt = freshVipExpireAt;
    }
  } catch (error) {
    console.warn("查询会员到期时间失败，沿用本地记录", error);
  }

  if (vipExpireAt > 0 && vipExpireAt * 1000 <= now) {
    const expiredUser: FeiniaoUser = { ...user, vipExpireAt, vipTime: formatVipTime(vipExpireAt) };
    await storage.set(USER_KEY, expiredUser);
    return rememberAuth({ ok: false, message: "会员已过期，请续费后再发布", user: expiredUser });
  }

  let nextUser = user;
  if (vipExpireAt > 0 && vipExpireAt !== user.vipExpireAt) {
    nextUser = { ...user, vipExpireAt, vipTime: formatVipTime(vipExpireAt) };
    await storage.set(USER_KEY, nextUser);
  }

  return rememberAuth({ ok: true, message: "", user: nextUser });
}

export function feiniaoMessageHandler(request, _sender, sendResponse: (response: unknown) => void): boolean {
  const action = String(request?.action ?? "");
  if (!action.startsWith("FEINIAO_")) {
    return false;
  }

  (async () => {
    try {
      switch (action) {
        case "FEINIAO_STATUS": {
          const auth = await ensureAuthorized();
          sendResponse({
            success: true,
            data: {
              loggedIn: auth.ok,
              user: auth.user ?? (await getStoredUser()),
              message: auth.message,
            },
          });
          return;
        }
        case "FEINIAO_LOGIN": {
          const { username, password } = request.data ?? {};
          if (!username || !password) {
            throw new Error("请填写账号和密码");
          }
          const user = await doLogin(String(username).trim(), String(password));
          sendResponse({ success: true, data: user });
          return;
        }
        case "FEINIAO_REGISTER": {
          const { username, password } = request.data ?? {};
          if (!username || !password) {
            throw new Error("请填写账号和密码");
          }
          await doRegister(String(username).trim(), String(password));
          sendResponse({ success: true, data: { username: String(username).trim() } });
          return;
        }
        case "FEINIAO_LOGOUT": {
          await doLogout();
          sendResponse({ success: true, data: null });
          return;
        }
        case "FEINIAO_HEARTBEAT": {
          const auth = await ensureAuthorized(true);
          if (!auth.ok) {
            throw new Error(auth.message);
          }
          sendResponse({ success: true, data: { status: "online" } });
          return;
        }
        default:
          sendResponse({ success: false, message: `未知操作：${action}` });
      }
    } catch (error) {
      sendResponse({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
}
