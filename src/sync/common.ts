import { getAccountInfoFromPlatformInfo, getAccountInfoFromPlatformInfos } from "./account";
import { ArticleInfoMap } from "./article";
import { DynamicInfoMap } from "./dynamic";
import { getExtraConfigFromPlatformInfo, getExtraConfigFromPlatformInfos } from "./extraconfig";
import { isPlatformEnabled } from "./platform-filter";
import { PodcastInfoMap } from "./podcast";
import { VideoInfoMap } from "./video";

export interface SyncDataPlatform {
  name: string;
  injectUrl?: string;
  extraConfig?:
    | {
        customInjectUrls?: string[]; // Beta 功能，用于自定义注入 URL
      }
    | unknown;
}

export interface SyncData {
  platforms: SyncDataPlatform[];
  isAutoPublish: boolean;
  data: DynamicData | ArticleData | VideoData | PodcastData;
  origin?: DynamicData | ArticleData | VideoData | PodcastData; // Beta 功能，用于临时存储，发布时不需要提供该字段
}

export interface DynamicData {
  title: string;
  content: string;
  images: FileData[];
  videos: FileData[];
  tags?: string[];
  scheduledPublishTime?: number;
}

export interface PodcastData {
  title: string;
  description: string;
  audio: FileData;
  cover?: FileData;
  tags?: string[];
  category?: string | number;
}

export interface FileData {
  name: string;
  url: string;
  type?: string;
  size?: number;
  /** 本地文件在 IndexedDB 中的 id，注入前会被解析成 blob URL */
  fileId?: string;
}

export interface ArticleData {
  title: string;
  digest: string;
  cover: FileData;
  htmlContent: string;
  markdownContent: string;
  images?: FileData[]; // 发布时可不提供该字段
  tags?: string[];
  category?: string | number; // 平台分类 ID 或名称
  original?: boolean; // 原创声明
  allowComment?: boolean;
  wordFileData?: FileData;
  scheduledPublishTime?: number;
}

export interface VideoData {
  title: string;
  content: string;
  video: FileData;
  tags?: string[];
  cover?: FileData;
  verticalCover?: FileData;
  horizontalCover?: FileData;
  videoFile?: File; // 原始 File 对象，用于避免 blob URL 问题
  scheduledPublishTime?: number;
  category?: string | number; // 平台分区 ID（如 B 站 tid，YouTube category）
  original?: boolean; // 原创声明
  collectionId?: string | number; // 合集/系列 ID（如 B 站 list_id）
  description?: string; // 描述（独立于 content/简介）
}

export interface PlatformInfo {
  type: "DYNAMIC" | "VIDEO" | "ARTICLE" | "PODCAST";
  name: string;
  homeUrl: string;
  faviconUrl?: string;
  iconifyIcon?: string;
  platformName: string;
  injectUrl: string;
  injectFunction: (data: SyncData) => Promise<void>;
  tags?: string[];
  accountKey: string;
  accountInfo?: AccountInfo;
  extraConfig?: unknown;
}

export interface AccountInfo {
  provider: string;
  accountId: string;
  username: string;
  description?: string;
  profileUrl?: string;
  avatarUrl?: string;
  extraData: unknown;
}

const allInfoMap: Record<string, PlatformInfo> = {
  ...DynamicInfoMap,
  ...ArticleInfoMap,
  ...VideoInfoMap,
  ...PodcastInfoMap,
};

// 只对外暴露白名单内的平台，其余平台在界面和注入链路上都不可见
export const infoMap: Record<string, PlatformInfo> = Object.fromEntries(
  Object.entries(allInfoMap).filter(([name]) => isPlatformEnabled(name)),
);

export async function getPlatformInfo(platform: string): Promise<PlatformInfo | null> {
  const platformInfo = infoMap[platform];
  if (platformInfo) {
    return await getExtraConfigFromPlatformInfo(await getAccountInfoFromPlatformInfo(platformInfo));
  }
  return null;
}

export function getRawPlatformInfo(platform: string): PlatformInfo | null {
  return infoMap[platform];
}

export async function getPlatformInfos(type?: "DYNAMIC" | "VIDEO" | "ARTICLE" | "PODCAST"): Promise<PlatformInfo[]> {
  const platformInfos: PlatformInfo[] = [];
  for (const info of Object.values(infoMap)) {
    if (type && info.type !== type) continue;
    platformInfos.push(info);
  }

  return await getExtraConfigFromPlatformInfos(await getAccountInfoFromPlatformInfos(platformInfos));
}

// Inject || 注入 || START
export async function createTabsForPlatforms(data: SyncData) {
  const tabs: { tab: chrome.tabs.Tab; platformInfo: SyncDataPlatform }[] = [];
  let groupId: number | undefined;

  for (const info of data.platforms) {
    let tab: chrome.tabs.Tab | null = null;
    // 未启用的平台直接跳过，避免外部消息硬编码平台名绕过白名单
    if (info && isPlatformEnabled(info.name)) {
      const extraConfig = info.extraConfig as { customInjectUrls?: string[] };
      if (extraConfig?.customInjectUrls && extraConfig.customInjectUrls.length > 0) {
        for (const url of extraConfig.customInjectUrls) {
          tab = await chrome.tabs.create({ url });
          info.injectUrl = url;
          // 等待标签页加载完成
          await new Promise<void>((resolve) => {
            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
              if (tabId === tab!.id && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            });
          });
        }
      } else {
        if (info.injectUrl) {
          tab = await chrome.tabs.create({ url: info.injectUrl });
        } else {
          const platformInfo = infoMap[info.name];
          if (platformInfo) {
            tab = await chrome.tabs.create({ url: platformInfo.injectUrl });
          }
        }
        // 等待标签页加载完成
        if (tab) {
          await injectScriptsToTabs([{ tab, platformInfo: info }], data);
          await chrome.tabs.update(tab.id!, { active: true });
          tabs.push({
            tab,
            platformInfo: info,
          });

          // 如果是第一个标签页，创建一个新组
          if (!groupId) {
            groupId = await chrome.tabs.group({ tabIds: [tab.id!] });
            await chrome.tabGroups.update(groupId, {
              color: "blue",
              title: `FgPost-${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
            });
          } else {
            // 将新标签页添加到现有组中
            await chrome.tabs.group({ tabIds: [tab.id!], groupId });
          }
          // 等待3秒再继续
          await new Promise<void>((resolve) => {
            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
              if (tabId === tab!.id && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            });
          });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }
  }

  return tabs;
}

function collectFileIds(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectFileIds(item, ids);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fileId === "string" && record.fileId) {
    ids.add(record.fileId);
  }
  for (const key of Object.keys(record)) {
    collectFileIds(record[key], ids);
  }
}

function replaceFileUrls(value: unknown, urls: Record<string, string>): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => replaceFileUrls(item, urls));
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    next[key] = replaceFileUrls(item, urls);
  }
  if (typeof record.fileId === "string" && urls[record.fileId]) {
    next.url = urls[record.fileId];
  }
  return next;
}

/**
 * 本地文件不随消息传输，注入前在目标页里按块取回并生成 blob URL。
 * 生成后的 data 与原结构一致，各平台实现仍然按 fetch(file.url) 使用。
 */
async function resolveLocalFiles(tabId: number, data: SyncData): Promise<SyncData> {
  const ids = new Set<string>();
  collectFileIds(data, ids);
  if (ids.size === 0) return data;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (fileIds: string[]) => {
        const decode = (input: string) => {
          const binary = atob(input);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          return bytes;
        };

        const urls: Record<string, string> = {};
        for (const fileId of fileIds) {
          const parts: BlobPart[] = [];
          let type = "";
          let index = 0;
          try {
            for (;;) {
              const response = await chrome.runtime.sendMessage({
                action: "FG_FILE_CHUNK",
                fileId,
                index,
              });
              if (!response || response.error) break;
              if (response.type) type = response.type;
              if (response.chunk) parts.push(decode(response.chunk));
              if (response.done) break;
              index += 1;
            }
            if (parts.length > 0) {
              urls[fileId] = URL.createObjectURL(new Blob(parts, { type }));
            }
          } catch {
            // 单个文件失败不影响其他文件
          }
        }
        return urls;
      },
      args: [Array.from(ids)],
    });
    const urls = (result?.result ?? {}) as Record<string, string>;
    return replaceFileUrls(data, urls) as SyncData;
  } catch (error) {
    console.warn("解析本地文件失败", error);
    return data;
  }
}

export async function injectScriptsToTabs(
  tabs: { tab: chrome.tabs.Tab; platformInfo: SyncDataPlatform }[],
  data: SyncData,
) {
  for (const t of tabs) {
    const tab = t.tab;
    const platform = t.platformInfo;
    if (tab.id) {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          getPlatformInfo(platform.name).then(async (info) => {
            if (info) {
              const resolved = await resolveLocalFiles(tab.id, data);
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: info.injectFunction,
                args: [resolved],
              });
            }
          });
        }
      });
    }
  }
}
// Inject || 注入 || END
