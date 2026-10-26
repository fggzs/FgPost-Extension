/**
 * 授权服务 SDK（cryptoType=3）TypeScript 实现
 * 协议：AES-192-CBC 加密请求体 -> RSA(PKCS1v1.5) 加密 AES 密钥 -> 服务端返回密文
 * 说明：服务端对 rsa_api_list 的接口使用 RSA 私钥加密 AES 密钥，客户端用公钥做模幂还原
 */

import { aesCbcDecrypt, aesCbcEncrypt } from "./aes";

export const FEINIAO_APP_WEB = "http://fnyz.aiwenshu.top/Api?AppId=10008";

/** 单次授权服务接口请求超时（毫秒） */
const FEINIAO_REQUEST_TIMEOUT_MS = 12000;

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDJzr0s7c1TAF5rTS2USzfqvJwD
3qvcCbE0Qij4PMO0SJP6NFzM597ig8kDKZLq3Yy7sEBNGCA/wmuWTeRB8+BXm2gu
dZ1T7zodvsEIWcColFKO5eD88b0gG3YVEoS73pK40r7fz0RROmU7O2MuJP9Nu7O/
bgS+ZR+WSx41OqWcBQIDAQAB
-----END PUBLIC KEY-----`;

/** 这些接口的响应密钥由 RSA 通道下发，其余接口使用 GetToken 返回的 CryptoKeyAes */
const RSA_API_LIST = [
  "GetToken",
  "UserLogin",
  "UserReduceMoney",
  "UserReduceVipNumber",
  "UserReduceVipTime",
  "GetVipData",
];

const STATUS_MIN = 10000;
const STATUS_MAX = 99999;

export interface FeiniaoSession {
  token: string;
  cryptoKeyAes: string;
}

export interface FeiniaoUser {
  username: string;
  vipTime?: string;
  /** 会员到期时间（秒级时间戳），用于发布前本地快判 */
  vipExpireAt?: number;
  loginAt: number;
}

interface ApiEnvelope {
  Status?: number;
  Msg?: string;
  Data?: Record<string, string | number>;
  a?: string;
  b?: string;
}

/* ------------------------------ base64 ------------------------------ */

function b64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/* ------------------------------ bigint ------------------------------ */

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex.length > 0 ? BigInt(`0x${hex}`) : 0n;
}

function bigIntToBytes(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let current = base % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * current) % modulus;
    }
    current = (current * current) % modulus;
    exp >>= 1n;
  }
  return result;
}

/* ------------------------------ RSA 公钥 ------------------------------ */

interface RsaPublicKey {
  n: bigint;
  e: bigint;
}

let cachedPublicKey: RsaPublicKey | null = null;

interface DerTlv {
  tag: number;
  start: number;
  length: number;
  next: number;
}

function readTlv(der: Uint8Array, offset: number): DerTlv {
  const tag = der[offset];
  let cursor = offset + 1;
  let length = der[cursor];
  cursor += 1;
  if (length & 0x80) {
    const byteCount = length & 0x7f;
    length = 0;
    for (let i = 0; i < byteCount; i += 1) {
      length = (length << 8) | der[cursor + i];
    }
    cursor += byteCount;
  }
  return { tag, start: cursor, length, next: cursor + length };
}

function getPublicKey(): RsaPublicKey {
  if (cachedPublicKey) {
    return cachedPublicKey;
  }
  const body = PUBLIC_KEY_PEM.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = b64ToBytes(body);

  // SubjectPublicKeyInfo: SEQUENCE { SEQUENCE(算法), BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
  const outer = readTlv(der, 0);
  if (outer.tag !== 0x30) {
    throw new Error("公钥格式错误：缺少外层 SEQUENCE");
  }
  const algorithm = readTlv(der, outer.start);
  const bitString = readTlv(der, algorithm.next);
  if (bitString.tag !== 0x03) {
    throw new Error("公钥格式错误：缺少 BIT STRING");
  }
  const rsaSequence = readTlv(der, bitString.start + 1);
  const modulusTlv = readTlv(der, rsaSequence.start);
  const exponentTlv = readTlv(der, modulusTlv.next);

  let modulusBytes = der.slice(modulusTlv.start, modulusTlv.start + modulusTlv.length);
  if (modulusBytes[0] === 0x00) {
    modulusBytes = modulusBytes.slice(1);
  }
  let exponentBytes = der.slice(exponentTlv.start, exponentTlv.start + exponentTlv.length);
  if (exponentBytes[0] === 0x00) {
    exponentBytes = exponentBytes.slice(1);
  }

  cachedPublicKey = { n: bytesToBigInt(modulusBytes), e: bytesToBigInt(exponentBytes) };
  return cachedPublicKey;
}

/** PKCS#1 v1.5 填充后做模幂，等价于 RSA 公钥加密 */
function rsaEncrypt(message: string): string {
  const key = getPublicKey();
  const messageBytes = new TextEncoder().encode(message);
  const k = bigIntToBytes(key.n).length;
  const paddingLength = k - messageBytes.length - 3;
  if (paddingLength < 8) {
    throw new Error("RSA 待加密内容过长");
  }

  const block = new Uint8Array(k);
  block[0] = 0x00;
  block[1] = 0x02;
  let cursor = 2;
  while (cursor < 2 + paddingLength) {
    const [randomByte] = crypto.getRandomValues(new Uint8Array(1));
    if (randomByte === 0) {
      continue;
    }
    block[cursor] = randomByte;
    cursor += 1;
  }
  block[cursor] = 0x00;
  block.set(messageBytes, cursor + 1);

  const cipher = modPow(bytesToBigInt(block), key.e, key.n);
  return bytesToB64(bigIntToBytes(cipher));
}

/** 服务端用私钥加密的内容，客户端用公钥做模幂还原（对应 Python 的 decrypt_with_public_key） */
function rsaPublicDecode(cipherB64: string): string {
  const key = getPublicKey();
  const cipherBytes = b64ToBytes(cipherB64);
  const plain = modPow(bytesToBigInt(cipherBytes), key.e, key.n);
  const raw = bigIntToBytes(plain);
  // 服务端用 PKCS#1 v1.5 签名填充（01 FF..FF 00）包裹密钥，与 Python 的 b64decode 一样过滤掉非 base64 字符
  const base64Text = new TextDecoder("latin1").decode(raw).replace(/[^A-Za-z0-9+/=]/g, "");
  return bytesToB64(b64ToBytes(base64Text));
}

/* ------------------------------ AES ------------------------------ */

/** 与 Python 端 adjust_key_iv 保持一致：不足 24 字节补零，够长则原样使用 */
function normalizeAesKey(keyText: string): Uint8Array {
  const raw = new TextEncoder().encode(keyText);
  if (raw.length < 24) {
    const padded = new Uint8Array(24);
    padded.set(raw);
    return padded;
  }
  return raw;
}

const AES_IV = new Uint8Array(16);

async function aesEncrypt(keyText: string, plainText: string): Promise<string> {
  // 使用自带实现：部分运行环境的 WebCrypto 不支持协议要求的 192 位密钥
  return bytesToB64(aesCbcEncrypt(normalizeAesKey(keyText), AES_IV, new TextEncoder().encode(plainText)));
}

async function aesDecrypt(keyText: string, cipherB64: string): Promise<string> {
  return new TextDecoder().decode(aesCbcDecrypt(normalizeAesKey(keyText), AES_IV, b64ToBytes(cipherB64)));
}

/* ------------------------------ 请求 ------------------------------ */

function randomAesKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let key = "";
  for (let i = 0; i < bytes.length; i += 1) {
    key += alphabet[bytes[i] % alphabet.length];
  }
  return key;
}

function randomStatus(): number {
  return Math.floor(Math.random() * (STATUS_MAX - STATUS_MIN + 1)) + STATUS_MIN;
}

interface ApiResponse {
  ok: boolean;
  data: ApiEnvelope;
}

async function request(session: FeiniaoSession, param: Record<string, unknown>): Promise<ApiResponse> {
  const status = randomStatus();
  const hasAdminNote = Object.prototype.hasOwnProperty.call(param, "AdminNote");
  const payload: Record<string, unknown> = hasAdminNote
    ? { ...param }
    : { Time: Math.floor(Date.now() / 1000), Status: status, ...param };

  const requestKey = randomAesKey();
  const a = await aesEncrypt(requestKey, JSON.stringify(payload));
  const b = rsaEncrypt(requestKey);

  // 加超时：授权服务接口不可达时不能把发布流程和无网络请求一起挂死
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEINIAO_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(FEINIAO_APP_WEB, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Token: session.token || "",
      },
      body: JSON.stringify({ a, b }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("授权服务器连接超时，请检查网络后重试");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`请求失败，状态码：${response.status}`);
  }

  const result = (await response.json()) as ApiEnvelope;

  // 明文响应
  if (typeof result.Status === "number") {
    return { ok: result.Status === status, data: result };
  }

  if (!result.a) {
    throw new Error("响应格式异常：缺少密文");
  }

  const api = String(param.Api ?? "");
  const responseKey = RSA_API_LIST.includes(api) ? rsaPublicDecode(result.b ?? "") : session.cryptoKeyAes;
  if (!responseKey) {
    throw new Error("缺少解密密钥，请先初始化 Token");
  }

  const plain = await aesDecrypt(responseKey, result.a);
  const parsed = JSON.parse(plain) as ApiEnvelope;
  return { ok: parsed.Status === status, data: parsed };
}

function assertOk(response: ApiResponse, fallback = "操作失败"): ApiEnvelope {
  if (response.ok) {
    return response.data;
  }
  const message = response.data?.Msg ?? fallback;
  throw new Error(message);
}

/* ------------------------------ 对外接口 ------------------------------ */

/** 初始化：获取 Token 与 CryptoKeyAes */
export async function initSession(): Promise<FeiniaoSession> {
  const empty: FeiniaoSession = { token: "", cryptoKeyAes: "" };
  const response = await request(empty, { Api: "GetToken" });
  const data = assertOk(response, "获取 Token 失败");
  const token = String(data.Data?.Token ?? "");
  const cryptoKeyAes = String(data.Data?.CryptoKeyAes ?? "");
  if (!token || !cryptoKeyAes) {
    throw new Error("获取 Token 失败：返回数据不完整");
  }
  return { token, cryptoKeyAes };
}

/** 用户注册 */
export async function registerUser(
  session: FeiniaoSession,
  username: string,
  password: string,
  machineCode: string,
): Promise<void> {
  const response = await request(session, {
    Api: "NewUserInfo",
    User: username,
    PassWord: password,
    Key: machineCode,
    SuperPassWord: "000000",
    Qq: "",
    Email: "",
    Phone: "",
  });
  assertOk(response, "注册失败");
}

export interface LoginResult {
  username: string;
  vipTime: string;
  /** 会员到期时间（秒级时间戳，0 表示未开通或无到期时间） */
  vipExpireAt: number;
}

/** 用户登录 */
export async function loginUser(
  session: FeiniaoSession,
  username: string,
  password: string,
  machineCode: string,
  tag = "FgPost",
): Promise<LoginResult> {
  const response = await request(session, {
    Api: "UserLogin",
    UserOrKa: username,
    PassWord: password,
    Key: machineCode,
    Tab: tag,
    AppVer: chrome.runtime.getManifest().version,
  });
  const data = assertOk(response, "登录失败");
  const vipExpireAt = toVipExpireAt(data.Data?.VipTime);
  return { username, vipExpireAt, vipTime: formatVipTime(vipExpireAt) };
}

/** 退出登录 */
export async function logoutUser(session: FeiniaoSession): Promise<void> {
  const response = await request(session, { Api: "LogOut" });
  assertOk(response, "退出登录失败");
}

/** 心跳（同时可校验登录态） */
export async function heartbeat(session: FeiniaoSession): Promise<string> {
  const response = await request(session, { Api: "HeartBeat" });
  const data = assertOk(response, "心跳失败");
  return String(data.Data?.Status ?? "");
}

/** 获取软件公告（非 RSA 接口，走 CryptoKeyAes 解密） */
export async function getNotice(session: FeiniaoSession): Promise<string> {
  const response = await request(session, { Api: "GetAppGongGao" });
  const data = assertOk(response, "获取公告失败");
  return String(data.Data?.AppGongGao ?? "");
}

/** 把接口返回的到期时间规整为秒级时间戳，非法或缺失统一返回 0 */
function toVipExpireAt(value: unknown): number {
  const timestamp = Number(value ?? 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : 0;
}

/** 秒级时间戳格式化为本地可读时间 */
export function formatVipTime(timestamp: number): string {
  return timestamp > 0 ? new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false }) : "未知";
}

/** 查询会员到期时间（秒级时间戳，0 表示未开通或无到期时间） */
export async function fetchVipExpireAt(session: FeiniaoSession): Promise<number> {
  const response = await request(session, { Api: "GetAppUserVipTime" });
  const data = assertOk(response, "查询到期时间失败");
  return toVipExpireAt(data.Data?.VipTime);
}

/** 查询会员到期时间（可读文本） */
export async function getVipTime(session: FeiniaoSession): Promise<string> {
  return formatVipTime(await fetchVipExpireAt(session));
}
