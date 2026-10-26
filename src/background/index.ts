import { Storage } from "@plasmohq/storage";
import { getAllAccountInfo } from "~sync/account";
import {
  // injectScriptsToTabs,
  type SyncData,
  type SyncDataPlatform,
  createTabsForPlatforms,
  getPlatformInfos,
} from "~sync/common";
import QuantumEntanglementKeepAlive from "../utils/keep-alive";
import { linkExtensionMessageHandler, starter } from "./services/api";
import { ensureAuthorized, feiniaoMessageHandler } from "./services/feiniao";
import {
  addTabsManagerMessages,
  tabsManagerHandleTabRemoved,
  tabsManagerHandleTabUpdated,
  tabsManagerMessageHandler,
} from "./services/tabs";
import { trustDomainMessageHandler } from "./services/trust-domain";

const storage = new Storage({
  area: "local",
});

async function initDefaultTrustedDomains() {
  const trustedDomains = await storage.get<Array<{ id: string; domain: string }>>("trustedDomains");
  if (!trustedDomains) {
    await storage.set("trustedDomains", [
      {
        id: crypto.randomUUID(),
        domain: "multipost.app",
      },
    ]);
  }
}

chrome.runtime.onInstalled.addListener((object) => {
  if (object.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.runtime.openOptionsPage();
  }
  initDefaultTrustedDomains();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

// 没有 popup 时，点击扩展图标直接打开完整操作页面
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

// Listen Message || 监听消息 || START
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handled =
    defaultMessageHandler(request, sender, sendResponse) ||
    tabsManagerMessageHandler(request, sender, sendResponse) ||
    trustDomainMessageHandler(request, sender, sendResponse) ||
    feiniaoMessageHandler(request, sender, sendResponse) ||
    linkExtensionMessageHandler(request, sender, sendResponse);
  return handled;
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  tabsManagerHandleTabUpdated(tabId, changeInfo, tab);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabsManagerHandleTabRemoved(tabId);
});
// Listen Message || 监听消息 || END

// Message Handler || 消息处理器 || START
let currentSyncData: SyncData | null = null;
let currentPublishPopup: chrome.windows.Window | null = null;
const defaultMessageHandler = (request, _sender, sendResponse) => {
  if (request.action === "MULTIPOST_EXTENSION_CHECK_SERVICE_STATUS") {
    sendResponse({
      extensionId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
      edition: "community",
    });
    return true;
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH") {
    (async () => {
      const auth = await ensureAuthorized();
      if (!auth.ok) {
        sendResponse({ error: "NOT_AUTHORIZED", message: auth.message });
        return;
      }
      const data = request.data as SyncData;
      currentSyncData = data;
      sendResponse({ status: "received", extensionId: chrome.runtime.id });
      currentPublishPopup = await chrome.windows.create({
        url: chrome.runtime.getURL("tabs/publish.html"),
        type: "popup",
        width: 800,
        height: 600,
      });
    })();
    return true;
  }
  if (request.action === "MULTIPOST_EXTENSION_PLATFORMS") {
    getPlatformInfos()
      .then((platforms) => {
        sendResponse({ platforms });
      })
      .catch((error) => {
        sendResponse({ error: String(error instanceof Error ? error.message : error) });
      });
    return true;
  }
  if (request.action === "MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS") {
    getAllAccountInfo()
      .then((accountInfo) => {
        sendResponse({ accountInfo });
      })
      .catch((error) => {
        sendResponse({ error: String(error instanceof Error ? error.message : error) });
      });
    return true;
  }
  if (request.action === "MULTIPOST_EXTENSION_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ extensionId: chrome.runtime.id });
    return true;
  }
  if (request.action === "MULTIPOST_EXTENSION_REFRESH_ACCOUNT_INFOS") {
    chrome.windows.create({
      url: chrome.runtime.getURL("tabs/refresh-accounts.html"),
      type: "popup",
      width: 800,
      height: 600,
      focused: request.data.isFocused || false,
    });
    sendResponse({ status: "ok" });
    return true;
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH_REQUEST_SYNC_DATA") {
    sendResponse({ syncData: currentSyncData });
    return true;
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH_NOW") {
    (async () => {
      const auth = await ensureAuthorized();
      if (!auth.ok) {
        sendResponse({ error: "NOT_AUTHORIZED", message: auth.message });
        return;
      }
      const data = request.data as SyncData;
      if (!Array.isArray(data?.platforms) || data.platforms.length === 0) {
        sendResponse({ tabs: [] });
        return;
      }
      try {
        const tabs = await createTabsForPlatforms(data);
        // await injectScriptsToTabs(tabs, data);

        addTabsManagerMessages({
          syncData: data,
          tabs: tabs.map((t: { tab: chrome.tabs.Tab; platformInfo: SyncDataPlatform }) => ({
            tab: t.tab,
            platformInfo: t.platformInfo,
          })),
        });

        // for (const t of tabs) {
        //   if (t.tab.id) {
        //     await chrome.tabs.update(t.tab.id, { active: true });
        //     await new Promise((resolve) => setTimeout(resolve, 2000));
        //   }
        // }
        if (currentPublishPopup) {
          await chrome.windows.update(currentPublishPopup.id, { focused: true });
        }

        sendResponse({
          tabs: tabs.map((t: { tab: chrome.tabs.Tab; platformInfo: SyncDataPlatform }) => ({
            tab: t.tab,
            platformInfo: t.platformInfo,
          })),
        });
      } catch (error) {
        // Do not sendResponse here: the publish popup's handlePublishComplete treats ANY
        // callback response as "publish complete", so an error payload would be mis-read as success.
        // Preserve original behavior (log only); success path above sends the tabs response.
        console.error("创建标签页或分组时出错:", error);
      }
    })();
    return true;
  }
  return false;
};
starter(1000 * 30);
// Message Handler || 消息处理器 || END

// Keep Alive || 保活机制 || START
const quantumKeepAlive = new QuantumEntanglementKeepAlive();
quantumKeepAlive.startEntanglementProcess();
// Keep Alive || 保活机制 || END
