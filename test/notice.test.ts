import { getNotice, initSession } from "../src/utils/feiniao.ts";
const session = await initSession();
const notice = await getNotice(session);
console.log("公告长度:", notice.length);
console.log("公告片段:", notice.slice(0, 80).replace(/<[^>]+>/g, ""));
console.log("第二条链路:", notice.length >= 0 ? "PASS" : "FAIL");
