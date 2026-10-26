import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { putFile } from "~utils/file-store";
import { publicMessage } from "~utils/text";

type ContentType = "DYNAMIC" | "VIDEO";

interface AccountInfo {
  username?: string;
  accountId?: string;
  avatarUrl?: string;
}

interface Platform {
  type: "DYNAMIC" | "VIDEO" | "ARTICLE" | "PODCAST";
  name: string;
  platformName: string;
  accountKey: string;
  injectUrl?: string;
  faviconUrl?: string;
  tags?: string[];
  accountInfo?: AccountInfo;
}

interface LocalPanelProps {
  compact?: boolean;
}

const CONTENT_TYPES: { key: ContentType; label: string; hint: string }[] = [
  { key: "DYNAMIC", label: "图文动态", hint: "标题 + 正文 + 本地图片" },
  { key: "VIDEO", label: "视频", hint: "标题 + 简介 + 本地视频" },
];

interface LocalFile {
  name: string;
  type: string;
  size: number;
  /** 本地文件在 IndexedDB 中的 id，发布时按块注入目标页 */
  fileId: string;
  /** 仅用于界面预览 */
  previewUrl?: string;
}

// 对齐抖音创作者平台：图片单张 20MB，视频 1GB
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 给消息请求加超时，避免后台卡住时界面一直没有反馈 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export default function LocalPanel({ compact = false }: LocalPanelProps) {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<"publish" | "account" | "me">("publish");
  const [contentType, setContentType] = useState<ContentType>("DYNAMIC");
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [images, setImages] = useState<LocalFile[]>([]);
  const [video, setVideo] = useState<LocalFile | null>(null);
  const [notice, setNotice] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const previews = useRef<Set<string>>(new Set());

  useEffect(() => {
    const store = previews.current;
    return () => {
      for (const url of store) {
        URL.revokeObjectURL(url);
      }
      store.clear();
    };
  }, []);

  const releasePreviews = (items: LocalFile[]) => {
    for (const item of items) {
      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        previews.current.delete(item.previewUrl);
      }
    }
  };

  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authUser, setAuthUser] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [account, setAccount] = useState<{ username: string; vipTime?: string } | null>(null);
  const [accountChecked, setAccountChecked] = useState(false);

  const loadPlatforms = useCallback(async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
      setLoadError("");
    }
    try {
      const response = await chrome.runtime.sendMessage({ action: "MULTIPOST_EXTENSION_PLATFORMS" });
      if (response?.error) throw new Error(response.error);
      setPlatforms(Array.isArray(response?.platforms) ? response.platforms : []);
      setLoadError("");
    } catch (error) {
      if (!silent) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlatforms();
  }, [loadPlatforms]);

  // 账号刷新窗口写入新的账号信息后，面板自动更新登录状态，避免显示旧的灰色状态
  useEffect(() => {
    const handleAccountChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === "local" && changes.multipost_account_info) {
        void loadPlatforms(true);
      }
    };
    const handleFocus = () => void loadPlatforms(true);
    chrome.storage.onChanged.addListener(handleAccountChange);
    window.addEventListener("focus", handleFocus);
    return () => {
      chrome.storage.onChanged.removeListener(handleAccountChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadPlatforms]);

  const loadAccount = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: "FEINIAO_STATUS" });
      const message = response?.data?.message || "";
      if (response?.success && response.data?.loggedIn) {
        setAccount(response.data.user);
      } else {
        setAccount(null);
        // 已登录但校验不通过（会员过期、在线校验失败）时给出具体原因
        if (response?.data?.user && message) {
          setAuthNotice(message);
        }
      }
    } catch {
      setAccount(null);
    } finally {
      setAccountChecked(true);
    }
  }, []);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  const submitAuth = async () => {
    if (!authUser.trim() || !authPassword) {
      setAuthNotice("请填写账号和密码");
      return;
    }
    setAuthBusy(true);
    setAuthNotice("");
    try {
      const action = authMode === "login" ? "FEINIAO_LOGIN" : "FEINIAO_REGISTER";
      const response = await chrome.runtime.sendMessage({
        action,
        data: { username: authUser.trim(), password: authPassword },
      });
      if (!response?.success) {
        throw new Error(response?.message || "操作失败");
      }
      if (authMode === "register") {
        setAuthNotice("注册成功，请使用新账号登录");
        setAuthMode("login");
        setAuthPassword("");
        return;
      }
      setAccount(response.data);
      setAuthNotice("登录成功");
      setAuthPassword("");
    } catch (error) {
      setAuthNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    setAuthBusy(true);
    setAuthNotice("");
    try {
      await chrome.runtime.sendMessage({ action: "FEINIAO_LOGOUT" });
      setAccount(null);
      setAuthNotice("已退出登录");
    } catch (error) {
      setAuthNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const checkOnline = async () => {
    setAuthBusy(true);
    setAuthNotice("");
    try {
      const response = await chrome.runtime.sendMessage({ action: "FEINIAO_HEARTBEAT" });
      setAuthNotice(response?.success ? "在线状态正常" : response?.message || "在线校验失败");
    } catch (error) {
      setAuthNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const platformsOfType = useMemo(
    () => platforms.filter((platform) => platform.type === contentType),
    [platforms, contentType],
  );

  const loggedInPlatforms = useMemo(
    () => platforms.filter((platform) => Boolean(platform.accountInfo?.username || platform.accountInfo?.accountId)),
    [platforms],
  );

  const togglePlatform = (name: string) => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]));
  };

  const switchContentType = (nextType: ContentType) => {
    setContentType(nextType);
    setSelected([]);
    setNotice("");
    releasePreviews(images);
    releasePreviews(video ? [video] : []);
    setImages([]);
    setVideo(null);
  };

  const pickImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setNotice("");
    const picked: LocalFile[] = [];
    let total = images.reduce((sum, item) => sum + item.size, 0);
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        setNotice(`已跳过非图片文件：${file.name}`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setNotice(`图片 ${file.name} 超过 ${formatSize(MAX_IMAGE_BYTES)}，已跳过`);
        continue;
      }
      if (total + file.size > MAX_IMAGE_TOTAL_BYTES) {
        setNotice(`图片总大小不能超过 ${formatSize(MAX_IMAGE_TOTAL_BYTES)}`);
        break;
      }
      total += file.size;
      const meta = await putFile(file);
      const previewUrl = URL.createObjectURL(file);
      previews.current.add(previewUrl);
      picked.push({ name: meta.name, type: meta.type, size: meta.size, fileId: meta.id, previewUrl });
    }
    if (picked.length > 0) {
      setImages((prev) => [...prev, ...picked]);
    }
  };

  const pickVideo = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setNotice("请选择视频文件");
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setNotice(`视频不能超过 ${formatSize(MAX_VIDEO_BYTES)}，请压缩后再选择`);
      return;
    }
    setNotice("");
    const meta = await putFile(file);
    if (video?.previewUrl) {
      URL.revokeObjectURL(video.previewUrl);
      previews.current.delete(video.previewUrl);
    }
    setVideo({ name: meta.name, type: meta.type, size: meta.size, fileId: meta.id });
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      const target = prev[index];
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        previews.current.delete(target.previewUrl);
      }
      return prev.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  const refreshAccounts = async () => {
    setIsBusy(true);
    setNotice("");
    try {
      await chrome.runtime.sendMessage({
        action: "MULTIPOST_EXTENSION_REFRESH_ACCOUNT_INFOS",
        data: { isFocused: true },
      });
      setNotice("已打开账号刷新窗口，刷新完成后回到这里即可");
    } catch (error) {
      setNotice(`刷新失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handlePublish = async () => {
    // 未登录时不发请求，直接把原因和入口给到用户
    if (!accountChecked) {
      setNotice("正在读取登录状态，请稍候再试");
      return;
    }
    if (!account) {
      const reason = authNotice || "未登录，请先登录后再发布";
      setNotice(reason);
      // 切到“我的”页并同步提示，避免用户以为点击没反应
      setAuthNotice(reason);
      setView("me");
      return;
    }
    if (selected.length === 0) {
      setNotice("请先选择至少一个平台");
      return;
    }
    if (!title.trim()) {
      setNotice("请填写标题");
      return;
    }
    if (contentType === "VIDEO" && !video) {
      setNotice("请选择视频文件");
      return;
    }
    if (contentType === "DYNAMIC" && !content.trim()) {
      setNotice("请填写正文内容");
      return;
    }

    const targetPlatforms = platformsOfType
      .filter((platform) => selected.includes(platform.name))
      .map((platform) => ({ name: platform.name, injectUrl: platform.injectUrl }));

    if (targetPlatforms.length === 0) {
      setNotice("所选平台与当前内容类型不匹配");
      return;
    }

    const imageFiles = images.map((item) => ({
      name: item.name,
      url: "",
      type: item.type,
      size: item.size,
      fileId: item.fileId,
    }));

    const data =
      contentType === "VIDEO"
        ? {
            title: title.trim(),
            content: content.trim(),
            video: {
              name: video.name,
              url: "",
              type: video.type,
              size: video.size,
              fileId: video.fileId,
            },
            tags: [],
          }
        : {
            title: title.trim(),
            content: content.trim(),
            images: imageFiles,
            videos: [],
          };

    setIsBusy(true);
    setNotice("正在校验发布权限…");
    try {
      const response = await withTimeout(
        chrome.runtime.sendMessage({
          action: "MULTIPOST_EXTENSION_PUBLISH",
          data: {
            platforms: targetPlatforms,
            isAutoPublish: true,
            data,
          },
        }),
        20000,
        "授权校验超时，请检查网络后重试",
      );
      if (response?.error) {
        throw new Error(response.message || "授权校验失败，请重新登录");
      }
      setNotice(`已提交 ${targetPlatforms.length} 个平台，正在打开发布页…`);
      if (compact) {
        setTimeout(() => window.close(), 1200);
      }
    } catch (error) {
      setNotice(`提交失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center ${compact ? "h-40" : "h-64"} text-sm text-gray-500`}>
        正在读取平台信息…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-4 text-sm text-red-600">
        读取平台信息失败：{loadError}
        <button
          type="button"
          onClick={() => loadPlatforms()}
          className="mt-3 block rounded-lg bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200">
          重试
        </button>
      </div>
    );
  }

  const tabButton = (key: "publish" | "account" | "me", label: string) => (
    <button
      type="button"
      onClick={() => setView(key)}
      className={`flex-1 rounded-lg px-3 py-1.5 text-sm transition ${
        view === key ? "bg-white font-medium text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
      }`}>
      {label}
    </button>
  );

  return (
    <div className={compact ? "w-[400px]" : "mx-auto w-full max-w-2xl"}>
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <img src={chrome.runtime.getURL("assets/icon.png")} alt="FgPost" className="h-7 w-7 rounded-lg" />
          <span className="text-base font-semibold text-gray-900">FgPost</span>
        </div>
        <button
          type="button"
          onClick={refreshAccounts}
          disabled={isBusy}
          className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50">
          刷新账号
        </button>
      </div>

      <div className="flex gap-1 bg-gray-50 p-1.5">
        {tabButton("publish", "发布")}
        {tabButton("account", `账号 ${loggedInPlatforms.length}`)}
        {tabButton("me", account ? account.username : "我的")}
      </div>

      <div className={`${compact ? "max-h-[440px]" : ""} overflow-y-auto p-4`}>
        {view === "publish" ? (
          <>
            <div className="flex gap-2">
              {CONTENT_TYPES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => switchContentType(item.key)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-left transition ${
                    contentType === item.key ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                  }`}>
                  <div className="text-sm font-medium text-gray-900">{item.label}</div>
                  <div className="mt-0.5 text-[11px] text-gray-500">{item.hint}</div>
                </button>
              ))}
            </div>

            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-600">发布平台（已选 {selected.length}）</span>
                <button
                  type="button"
                  onClick={() =>
                    setSelected(
                      selected.length === platformsOfType.length ? [] : platformsOfType.map((item) => item.name),
                    )
                  }
                  className="text-xs text-blue-600 hover:underline">
                  {selected.length === platformsOfType.length ? "全不选" : "全选"}
                </button>
              </div>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {platformsOfType.length === 0 && <span className="text-xs text-gray-400">暂无可用平台</span>}
                {platformsOfType.map((platform) => {
                  const isActive = selected.includes(platform.name);
                  const isLoggedIn = Boolean(platform.accountInfo);
                  return (
                    <button
                      key={platform.name}
                      type="button"
                      onClick={() => togglePlatform(platform.name)}
                      className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
                        isActive
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-gray-200 text-gray-600 hover:border-gray-300"
                      }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${isLoggedIn ? "bg-green-500" : "bg-gray-300"}`} />
                      {platform.platformName}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-gray-400">
                绿点表示检测到已登录账号，灰点表示未检测到（不影发布，但可能需要在发布页登录）
              </p>
            </div>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">标题</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="必填"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">
                  {contentType === "VIDEO" ? "简介" : "正文"}
                </span>
                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={4}
                  placeholder={contentType === "VIDEO" ? "视频简介（可留空）" : "必填，支持纯文本"}
                  className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </label>

              {contentType === "DYNAMIC" ? (
                <div>
                  <span className="mb-1 block text-xs font-medium text-gray-600">
                    图片（本地文件，可多选，单张 ≤ {formatSize(MAX_IMAGE_BYTES)}，合计 ≤{" "}
                    {formatSize(MAX_IMAGE_TOTAL_BYTES)}）
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      void pickImages(event.target.files);
                      event.target.value = "";
                    }}
                    className="block w-full cursor-pointer rounded-lg border border-gray-200 text-xs text-gray-600 file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-xs file:text-blue-600"
                  />
                  {images.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {images.map((item, index) => (
                        <div
                          key={`${item.name}-${index}`}
                          className="relative h-16 w-16 overflow-hidden rounded-lg border border-gray-200">
                          <img src={item.previewUrl} alt={item.name} className="h-full w-full object-cover" />
                          <button
                            type="button"
                            onClick={() => removeImage(index)}
                            className="absolute right-0 top-0 h-4 w-4 rounded-bl bg-black/50 text-[10px] leading-none text-white hover:bg-red-500">
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <span className="mb-1 block text-xs font-medium text-gray-600">
                    视频（本地文件，不超过 {formatSize(MAX_VIDEO_BYTES)}，文件越大准备时间越久）
                  </span>
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(event) => {
                      void pickVideo(event.target.files);
                      event.target.value = "";
                    }}
                    className="block w-full cursor-pointer rounded-lg border border-gray-200 text-xs text-gray-600 file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-xs file:text-blue-600"
                  />
                  {video && (
                    <div className="mt-2 flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-xs">
                      <span className="truncate text-gray-700">{video.name}</span>
                      <div className="ml-2 flex shrink-0 items-center gap-2">
                        <span className="text-gray-400">{formatSize(video.size)}</span>
                        <button
                          type="button"
                          onClick={() => setVideo(null)}
                          className="text-gray-400 hover:text-red-500">
                          移除
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handlePublish}
              disabled={isBusy}
              className="mt-4 w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50">
              {isBusy ? "正在提交…" : "开始发布"}
            </button>

            {notice && <p className="mt-2 text-xs text-gray-600">{publicMessage(notice)}</p>}
          </>
        ) : view === "account" ? (
          <>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium text-gray-600">已登录账号</span>
              <button type="button" onClick={() => loadPlatforms()} className="text-xs text-blue-600 hover:underline">
                重新读取
              </button>
            </div>

            {loggedInPlatforms.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 px-3 py-8 text-center">
                <p className="text-sm text-gray-500">还没有检测到已登录账号</p>
                <p className="mt-1 text-xs text-gray-400">先在浏览器里登录各平台，再点“刷新账号”</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {loggedInPlatforms.map((platform) => (
                  <li
                    key={platform.name}
                    className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2">
                    {platform.accountInfo?.avatarUrl ? (
                      <img src={platform.accountInfo.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-[10px] text-gray-500">
                        {platform.platformName.slice(0, 1)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-gray-900">{platform.platformName}</div>
                      <div className="truncate text-xs text-gray-500">
                        {platform.accountInfo?.username || platform.accountInfo?.accountId || "已登录"}
                      </div>
                    </div>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
                      {platform.type === "VIDEO" ? "视频" : platform.type === "DYNAMIC" ? "动态" : platform.type}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={refreshAccounts}
              disabled={isBusy}
              className="mt-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-50">
              刷新全部账号状态
            </button>
            {notice && <p className="mt-2 text-xs text-gray-600">{publicMessage(notice)}</p>}
          </>
        ) : (
          <>
            {account ? (
              <>
                <div className="rounded-xl border border-gray-200 p-4">
                  <div className="text-xs text-gray-500">当前账号</div>
                  <div className="mt-1 text-lg font-semibold text-gray-900">{account.username}</div>
                  <div className="mt-2 text-xs text-gray-500">会员到期：{account.vipTime || "未知"}</div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={checkOnline}
                    disabled={authBusy}
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-50">
                    在线校验
                  </button>
                  <button
                    type="button"
                    onClick={logout}
                    disabled={authBusy}
                    className="flex-1 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 transition hover:bg-red-50 disabled:opacity-50">
                    退出登录
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-3 flex gap-1 rounded-lg bg-gray-100 p-1">
                  {(["login", "register"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setAuthMode(mode);
                        setAuthNotice("");
                      }}
                      className={`flex-1 rounded-md px-3 py-1.5 text-sm transition ${
                        authMode === mode ? "bg-white font-medium text-blue-600 shadow-sm" : "text-gray-500"
                      }`}>
                      {mode === "login" ? "登录" : "注册"}
                    </button>
                  ))}
                </div>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-600">账号</span>
                  <input
                    value={authUser}
                    onChange={(event) => setAuthUser(event.target.value)}
                    placeholder="手机号或用户名"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </label>

                <label className="mt-3 block">
                  <span className="mb-1 block text-xs font-medium text-gray-600">密码</span>
                  <input
                    type="password"
                    value={authPassword}
                    onChange={(event) => setAuthPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitAuth();
                    }}
                    placeholder="请输入密码"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </label>

                <button
                  type="button"
                  onClick={submitAuth}
                  disabled={authBusy}
                  className="mt-4 w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50">
                  {authBusy ? "处理中…" : authMode === "login" ? "登录" : "注册并登录"}
                </button>
              </>
            )}
            {authNotice && <p className="mt-2 text-xs text-gray-600">{publicMessage(authNotice)}</p>}
          </>
        )}
      </div>

      <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
        FgPost v{chrome.runtime.getManifest().version} · 需登录授权后发布
      </div>
    </div>
  );
}
