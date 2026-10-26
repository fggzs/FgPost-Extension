/**
 * 飞鸟 SDK 协议自测（Node 24 直接运行：node --experimental-strip-types test/feiniao.test.ts）
 * 只验证加解密通道，不涉及账号密码。
 */
import { initSession } from "../src/utils/feiniao.ts";

const session = await initSession();
console.log("Token =", session.token);
console.log("CryptoKeyAes =", session.cryptoKeyAes);
console.log("长度校验:", session.token.length > 0 && session.cryptoKeyAes.length >= 16 ? "PASS" : "FAIL");
