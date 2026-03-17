import { ArrowLeft, ArrowRight, Camera, Globe, Layers, Loader2, Play, Plus, RefreshCw, Square, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SandboxAgentError } from "sandbox-agent";
import type { BrowserConsoleMessage, BrowserContextInfo, BrowserStatusResponse, BrowserTabInfo, SandboxAgent } from "sandbox-agent";
import { DesktopViewer } from "@sandbox-agent/react";
import type { BrowserViewerClient } from "@sandbox-agent/react";

const MIN_SPIN_MS = 350;

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof SandboxAgentError && error.problem?.detail) return error.problem.detail;
  if (error instanceof Error) return error.message;
  return fallback;
};

const formatStartedAt = (value: string | null | undefined): string => {
  if (!value) return "Not started";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const createScreenshotUrl = async (bytes: Uint8Array, mimeType = "image/png"): Promise<string> => {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const blob = new Blob([payload.buffer], { type: mimeType });
  if (typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(blob);
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read screenshot blob."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read screenshot blob."));
      }
    };
    reader.readAsDataURL(blob);
  });
};

const CONSOLE_LEVELS = ["all", "log", "warn", "error", "info"] as const;

const consoleLevelColor = (level: string): string => {
  switch (level) {
    case "error":
      return "var(--danger, #ef4444)";
    case "warning":
      return "var(--warning, #f59e0b)";
    case "info":
      return "var(--info, #3b82f6)";
    default:
      return "var(--muted)";
  }
};

const BrowserTab = ({ getClient }: { getClient: () => SandboxAgent }) => {
  // Status
  const [status, setStatus] = useState<BrowserStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Config inputs
  const [width, setWidth] = useState("1280");
  const [height, setHeight] = useState("720");
  const [startUrl, setStartUrl] = useState("");
  const [contextId, setContextId] = useState("");
  const [contexts, setContexts] = useState<BrowserContextInfo[]>([]);

  // Screenshot
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [screenshotFormat, setScreenshotFormat] = useState<"png" | "jpeg" | "webp">("png");
  const [screenshotQuality, setScreenshotQuality] = useState("85");
  const [screenshotFullPage, setScreenshotFullPage] = useState(false);
  const [screenshotSelector, setScreenshotSelector] = useState("");

  // Tabs
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [tabsError, setTabsError] = useState<string | null>(null);
  const [newTabUrl, setNewTabUrl] = useState("");
  const [tabActing, setTabActing] = useState<string | null>(null);

  // Console
  const [consoleMessages, setConsoleMessages] = useState<BrowserConsoleMessage[]>([]);
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [consoleLevel, setConsoleLevel] = useState<string>("all");
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Live view
  const [liveViewActive, setLiveViewActive] = useState(false);
  const [liveViewError, setLiveViewError] = useState<string | null>(null);
  const [navUrl, setNavUrl] = useState("");
  const [isNavigating, setIsNavigating] = useState(false);

  const isActive = status?.state === "active";

  const resolutionLabel = useMemo(() => {
    const resolution = status?.resolution;
    if (!resolution) return "Unknown";
    return `${resolution.width} x ${resolution.height}`;
  }, [status?.resolution]);

  const viewerClient = useMemo<BrowserViewerClient>(() => {
    const c = getClient();
    return {
      connectDesktopStream: (opts?: Parameters<SandboxAgent["connectDesktopStream"]>[0]) => c.connectDesktopStream(opts),
      browserNavigate: (req) => c.browserNavigate(req),
      browserBack: () => c.browserBack(),
      browserForward: () => c.browserForward(),
      browserReload: (req?) => c.browserReload(req),
      getBrowserStatus: () => c.getBrowserStatus(),
    };
  }, [getClient]);

  const loadStatus = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const next = await getClient().getBrowserStatus();
        setStatus(next);
        if (next.url) setNavUrl(next.url);
        return next;
      } catch (loadError) {
        setError(extractErrorMessage(loadError, "Unable to load browser status."));
        return null;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [getClient],
  );

  const loadContexts = useCallback(async () => {
    try {
      const result = await getClient().getBrowserContexts();
      setContexts(result.contexts);
    } catch {
      // non-critical
    }
  }, [getClient]);

  // Screenshot
  const revokeScreenshotUrl = useCallback(() => {
    setScreenshotUrl((current) => {
      if (current?.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, []);

  const refreshScreenshot = useCallback(async () => {
    setScreenshotLoading(true);
    setScreenshotError(null);
    try {
      const quality = Number.parseInt(screenshotQuality, 10);
      const request: Parameters<SandboxAgent["takeBrowserScreenshot"]>[0] = {
        format: screenshotFormat !== "png" ? screenshotFormat : undefined,
        quality: screenshotFormat !== "png" && Number.isFinite(quality) ? quality : undefined,
        fullPage: screenshotFullPage || undefined,
        selector: screenshotSelector.trim() || undefined,
      };
      const bytes = await getClient().takeBrowserScreenshot(request);
      revokeScreenshotUrl();
      const mimeType = screenshotFormat === "jpeg" ? "image/jpeg" : screenshotFormat === "webp" ? "image/webp" : "image/png";
      setScreenshotUrl(await createScreenshotUrl(bytes, mimeType));
    } catch (captureError) {
      revokeScreenshotUrl();
      setScreenshotError(extractErrorMessage(captureError, "Unable to capture browser screenshot."));
    } finally {
      setScreenshotLoading(false);
    }
  }, [getClient, revokeScreenshotUrl, screenshotFormat, screenshotQuality, screenshotFullPage, screenshotSelector]);

  // Tabs
  const loadTabs = useCallback(async () => {
    setTabsLoading(true);
    setTabsError(null);
    try {
      const result = await getClient().getBrowserTabs();
      setTabs(result.tabs);
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to load tabs."));
    } finally {
      setTabsLoading(false);
    }
  }, [getClient]);

  const handleCreateTab = async () => {
    setTabActing("new");
    setTabsError(null);
    try {
      await getClient().createBrowserTab(newTabUrl.trim() ? { url: newTabUrl.trim() } : {});
      setNewTabUrl("");
      await loadTabs();
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to create tab."));
    } finally {
      setTabActing(null);
    }
  };

  const handleActivateTab = async (tabId: string) => {
    setTabActing(tabId);
    setTabsError(null);
    try {
      await getClient().activateBrowserTab(tabId);
      await loadTabs();
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to activate tab."));
    } finally {
      setTabActing(null);
    }
  };

  const handleCloseTab = async (tabId: string) => {
    setTabActing(tabId);
    setTabsError(null);
    try {
      await getClient().closeBrowserTab(tabId);
      await loadTabs();
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to close tab."));
    } finally {
      setTabActing(null);
    }
  };

  // Console
  const loadConsole = useCallback(async () => {
    setConsoleLoading(true);
    setConsoleError(null);
    try {
      const query = consoleLevel !== "all" ? { level: consoleLevel } : {};
      const result = await getClient().getBrowserConsole(query);
      setConsoleMessages(result.messages);
    } catch (err) {
      setConsoleError(extractErrorMessage(err, "Unable to load console messages."));
    } finally {
      setConsoleLoading(false);
    }
  }, [getClient, consoleLevel]);

  // Initial load
  useEffect(() => {
    void loadStatus();
    void loadContexts();
  }, [loadStatus, loadContexts]);

  // Auto-refresh status every 5s when active
  useEffect(() => {
    if (status?.state !== "active") return;
    const interval = setInterval(() => void loadStatus("refresh"), 5000);
    return () => clearInterval(interval);
  }, [status?.state, loadStatus]);

  // Load tabs and console when browser becomes active
  useEffect(() => {
    if (status?.state === "active") {
      void loadTabs();
      void loadConsole();
    }
  }, [status?.state, loadTabs, loadConsole]);

  // Auto-refresh console every 3s when active
  useEffect(() => {
    if (status?.state !== "active") return;
    const interval = setInterval(() => void loadConsole(), 3000);
    return () => clearInterval(interval);
  }, [status?.state, loadConsole]);

  // Cleanup screenshot URL on unmount
  useEffect(() => {
    return () => revokeScreenshotUrl();
  }, [revokeScreenshotUrl]);

  // Reset live view when browser becomes inactive
  useEffect(() => {
    if (status?.state !== "active") {
      setLiveViewActive(false);
    }
  }, [status?.state]);

  const handleStart = async () => {
    const parsedWidth = Number.parseInt(width, 10);
    const parsedHeight = Number.parseInt(height, 10);
    setActing("start");
    setError(null);
    const startedAt = Date.now();
    try {
      const request: Parameters<SandboxAgent["startBrowser"]>[0] = {
        width: Number.isFinite(parsedWidth) ? parsedWidth : undefined,
        height: Number.isFinite(parsedHeight) ? parsedHeight : undefined,
        url: startUrl.trim() || undefined,
        contextId: contextId || undefined,
      };
      const next = await getClient().startBrowser(request);
      setStatus(next);
      if (next.url) setNavUrl(next.url);
    } catch (startError) {
      setError(extractErrorMessage(startError, "Unable to start browser."));
      await loadStatus("refresh");
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS - elapsedMs));
      }
      setActing(null);
    }
  };

  const handleStop = async () => {
    setActing("stop");
    setError(null);
    const startedAt = Date.now();
    try {
      const next = await getClient().stopBrowser();
      setStatus(next);
      setLiveViewActive(false);
    } catch (stopError) {
      setError(extractErrorMessage(stopError, "Unable to stop browser."));
      await loadStatus("refresh");
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS - elapsedMs));
      }
      setActing(null);
    }
  };

  const handleNavigate = async (url: string) => {
    if (!url.trim()) return;
    setIsNavigating(true);
    try {
      let normalizedUrl = url.trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      const page = await getClient().browserNavigate({ url: normalizedUrl });
      setNavUrl(page.url ?? "");
    } catch {
      // navigation error silently ignored
    } finally {
      setIsNavigating(false);
    }
  };

  const handleBack = async () => {
    setIsNavigating(true);
    try {
      const page = await getClient().browserBack();
      setNavUrl(page.url ?? "");
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  };

  const handleForward = async () => {
    setIsNavigating(true);
    try {
      const page = await getClient().browserForward();
      setNavUrl(page.url ?? "");
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  };

  const handleReload = async () => {
    setIsNavigating(true);
    try {
      const page = await getClient().browserReload();
      setNavUrl(page.url ?? "");
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  };

  return (
    <div className="desktop-panel">
      <div className="inline-row" style={{ marginBottom: 16 }}>
        <button className="button secondary small" onClick={() => void loadStatus("refresh")} disabled={loading || refreshing}>
          <RefreshCw className={`button-icon ${loading || refreshing ? "spinner-icon" : ""}`} />
          Refresh Status
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {/* ========== Runtime Control Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Globe size={14} style={{ marginRight: 6 }} />
            Browser Runtime
          </span>
          <span
            className={`pill ${
              status?.state === "active" ? "success" : status?.state === "install_required" ? "warning" : status?.state === "failed" ? "danger" : ""
            }`}
          >
            {status?.state ?? "unknown"}
          </span>
        </div>

        <div className="desktop-state-grid">
          <div>
            <div className="card-meta">URL</div>
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
              {status?.url ?? "None"}
            </div>
          </div>
          <div>
            <div className="card-meta">Resolution</div>
            <div className="mono">{resolutionLabel}</div>
          </div>
          <div>
            <div className="card-meta">Started</div>
            <div>{formatStartedAt(status?.startedAt)}</div>
          </div>
        </div>

        <div className="desktop-start-controls">
          <div className="desktop-input-group">
            <label className="label">Width</label>
            <input className="setup-input mono" value={width} onChange={(e) => setWidth(e.target.value)} inputMode="numeric" />
          </div>
          <div className="desktop-input-group">
            <label className="label">Height</label>
            <input className="setup-input mono" value={height} onChange={(e) => setHeight(e.target.value)} inputMode="numeric" />
          </div>
          <div className="desktop-input-group">
            <label className="label">URL</label>
            <input className="setup-input mono" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="https://example.com" />
          </div>
          <div className="desktop-input-group">
            <label className="label">Context</label>
            <select className="setup-input mono" value={contextId} onChange={(e) => setContextId(e.target.value)}>
              <option value="">Default (ephemeral)</option>
              {contexts.map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name} ({ctx.id.slice(0, 8)})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="card-actions">
          {isActive ? (
            <button className="button danger small" onClick={() => void handleStop()} disabled={acting === "stop"}>
              {acting === "stop" ? <Loader2 className="button-icon spinner-icon" /> : <Square className="button-icon" />}
              Stop Browser
            </button>
          ) : (
            <button className="button success small" onClick={() => void handleStart()} disabled={acting === "start"}>
              {acting === "start" ? <Loader2 className="button-icon spinner-icon" /> : <Play className="button-icon" />}
              Start Browser
            </button>
          )}
        </div>
      </div>

      {/* ========== Missing Dependencies ========== */}
      {status?.missingDependencies && status.missingDependencies.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Missing Dependencies</span>
          </div>
          <div className="desktop-chip-list">
            {status.missingDependencies.map((dep) => (
              <span key={dep} className="pill warning">
                {dep}
              </span>
            ))}
          </div>
          {status.installCommand && (
            <>
              <div className="card-meta" style={{ marginTop: 12 }}>
                Install command
              </div>
              <div className="mono desktop-command">{status.installCommand}</div>
            </>
          )}
        </div>
      )}

      {/* ========== Live View Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Globe size={14} style={{ marginRight: 6 }} />
            Live View
          </span>
          {isActive && (
            <button
              className={`button small ${liveViewActive ? "danger" : "success"}`}
              onClick={(e) => {
                e.stopPropagation();
                if (liveViewActive) {
                  setLiveViewActive(false);
                  void getClient()
                    .stopDesktopStream()
                    .catch(() => undefined);
                } else {
                  void getClient()
                    .startDesktopStream()
                    .then(() => {
                      setLiveViewActive(true);
                    })
                    .catch(() => undefined);
                }
              }}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {liveViewActive ? (
                <>
                  <Square size={12} style={{ marginRight: 4 }} />
                  Stop Stream
                </>
              ) : (
                <>
                  <Play size={12} style={{ marginRight: 4 }} />
                  Start Stream
                </>
              )}
            </button>
          )}
        </div>

        {liveViewError && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {liveViewError}
          </div>
        )}

        {!isActive && <div className="desktop-screenshot-empty">Start the browser runtime to enable live view.</div>}

        {isActive && liveViewActive && (
          <>
            {/* Navigation Bar */}
            <div className="inline-row" style={{ marginBottom: 8, gap: 4 }}>
              <button
                className="button ghost small"
                onClick={() => void handleBack()}
                disabled={isNavigating}
                style={{ padding: "4px 8px", fontSize: 11, minWidth: 28 }}
                title="Back"
              >
                <ArrowLeft size={12} />
              </button>
              <button
                className="button ghost small"
                onClick={() => void handleForward()}
                disabled={isNavigating}
                style={{ padding: "4px 8px", fontSize: 11, minWidth: 28 }}
                title="Forward"
              >
                <ArrowRight size={12} />
              </button>
              <button
                className="button ghost small"
                onClick={() => void handleReload()}
                disabled={isNavigating}
                style={{ padding: "4px 8px", fontSize: 11, minWidth: 28 }}
                title="Reload"
              >
                <RefreshCw size={12} className={isNavigating ? "spinner-icon" : ""} />
              </button>
              <input
                className="setup-input mono"
                value={navUrl}
                onChange={(e) => setNavUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleNavigate(navUrl);
                  }
                }}
                placeholder="Enter URL..."
                style={{ flex: 1, fontSize: 11 }}
              />
            </div>

            <DesktopViewer
              client={viewerClient}
              height={360}
              showStatusBar={false}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "linear-gradient(180deg, rgba(15, 23, 42, 0.92) 0%, rgba(17, 24, 39, 0.98) 100%)",
                boxShadow: "none",
              }}
            />

            {status?.url && (
              <div className="mono" style={{ marginTop: 4, fontSize: 10, color: "var(--muted)", wordBreak: "break-all" }}>
                {status.url}
              </div>
            )}
          </>
        )}

        {isActive && !liveViewActive && <div className="desktop-screenshot-empty">Click "Start Stream" for live browser view.</div>}
      </div>

      {/* ========== Screenshot Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Camera size={14} style={{ marginRight: 6 }} />
              Screenshot
            </span>
            <button
              className="button secondary small"
              onClick={() => void refreshScreenshot()}
              disabled={screenshotLoading}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {screenshotLoading ? <Loader2 size={12} className="spinner-icon" /> : <Camera size={12} style={{ marginRight: 4 }} />}
              Capture
            </button>
          </div>

          <div className="desktop-screenshot-controls">
            <div className="desktop-input-group">
              <label className="label">Format</label>
              <select className="setup-input mono" value={screenshotFormat} onChange={(e) => setScreenshotFormat(e.target.value as "png" | "jpeg" | "webp")}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
            </div>
            {screenshotFormat !== "png" && (
              <div className="desktop-input-group">
                <label className="label">Quality</label>
                <input
                  className="setup-input mono"
                  value={screenshotQuality}
                  onChange={(e) => setScreenshotQuality(e.target.value)}
                  inputMode="numeric"
                  style={{ maxWidth: 60 }}
                />
              </div>
            )}
            <label className="desktop-checkbox-label">
              <input type="checkbox" checked={screenshotFullPage} onChange={(e) => setScreenshotFullPage(e.target.checked)} />
              Full page
            </label>
            <div className="desktop-input-group">
              <label className="label">Selector</label>
              <input
                className="setup-input mono"
                value={screenshotSelector}
                onChange={(e) => setScreenshotSelector(e.target.value)}
                placeholder="e.g. #main"
                style={{ maxWidth: 140 }}
              />
            </div>
          </div>

          {screenshotError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {screenshotError}
            </div>
          )}

          {screenshotUrl ? (
            <div className="desktop-screenshot-frame">
              <img src={screenshotUrl} alt="Browser screenshot" className="desktop-screenshot-image" />
            </div>
          ) : (
            <div className="desktop-screenshot-empty">Click "Capture" to take a browser screenshot.</div>
          )}
        </div>
      )}

      {/* ========== Tabs Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Layers size={14} style={{ marginRight: 6 }} />
              Tabs
            </span>
            <button className="button secondary small" onClick={() => void loadTabs()} disabled={tabsLoading} style={{ padding: "4px 8px", fontSize: 11 }}>
              {tabsLoading ? <Loader2 size={12} className="spinner-icon" /> : <RefreshCw size={12} />}
            </button>
          </div>

          {tabsError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {tabsError}
            </div>
          )}

          {tabs.length > 0 ? (
            <div className="desktop-process-list">
              {tabs.map((tab) => (
                <div key={tab.id} className={`desktop-window-item ${tab.active ? "desktop-window-focused" : ""}`}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong style={{ fontSize: 12 }}>{tab.title || "(untitled)"}</strong>
                      {tab.active && (
                        <span className="pill success" style={{ marginLeft: 8 }}>
                          active
                        </span>
                      )}
                      <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, wordBreak: "break-all" }}>
                        {tab.url}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                      {!tab.active && (
                        <button
                          className="button ghost small"
                          title="Activate"
                          onClick={() => void handleActivateTab(tab.id)}
                          disabled={tabActing === tab.id}
                          style={{ padding: "4px 8px", fontSize: 11 }}
                        >
                          {tabActing === tab.id ? <Loader2 size={12} className="spinner-icon" /> : <Play size={12} />}
                        </button>
                      )}
                      <button
                        className="button ghost small"
                        title="Close"
                        onClick={() => void handleCloseTab(tab.id)}
                        disabled={tabActing === tab.id}
                        style={{ padding: "4px 8px", fontSize: 11 }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="desktop-screenshot-empty">No tabs open.</div>
          )}

          <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
            <input
              className="setup-input mono"
              value={newTabUrl}
              onChange={(e) => setNewTabUrl(e.target.value)}
              placeholder="https://example.com"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateTab();
              }}
              style={{ flex: 1, fontSize: 11 }}
            />
            <button
              className="button secondary small"
              onClick={() => void handleCreateTab()}
              disabled={tabActing === "new"}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {tabActing === "new" ? <Loader2 size={12} className="spinner-icon" /> : <Plus size={12} style={{ marginRight: 4 }} />}
              New Tab
            </button>
          </div>
        </div>
      )}

      {/* ========== Console Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Terminal size={14} style={{ marginRight: 6 }} />
              Console
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                className="button secondary small"
                onClick={() => void loadConsole()}
                disabled={consoleLoading}
                style={{ padding: "4px 8px", fontSize: 11 }}
              >
                {consoleLoading ? <Loader2 size={12} className="spinner-icon" /> : <RefreshCw size={12} />}
              </button>
            </div>
          </div>

          {/* Level filter pills */}
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
            {CONSOLE_LEVELS.map((level) => (
              <button
                key={level}
                className={`button small ${consoleLevel === level ? "secondary" : "ghost"}`}
                onClick={() => setConsoleLevel(level)}
                style={{ padding: "2px 10px", fontSize: 11, textTransform: "capitalize" }}
              >
                {level}
              </button>
            ))}
          </div>

          {consoleError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {consoleError}
            </div>
          )}

          {consoleMessages.length > 0 ? (
            <div
              style={{
                maxHeight: 240,
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 6,
                background: "var(--background, #0f172a)",
              }}
            >
              {consoleMessages.map((msg, idx) => (
                <div
                  key={`${msg.timestamp}-${idx}`}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "3px 4px",
                    fontSize: 11,
                    fontFamily: "monospace",
                    borderBottom: idx < consoleMessages.length - 1 ? "1px solid var(--border)" : undefined,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: consoleLevelColor(msg.level),
                      flexShrink: 0,
                      marginTop: 5,
                    }}
                  />
                  <span style={{ color: consoleLevelColor(msg.level), minWidth: 36, flexShrink: 0 }}>{msg.level}</span>
                  <span style={{ flex: 1, wordBreak: "break-all", color: "var(--foreground, #e2e8f0)" }}>{msg.text}</span>
                  <span style={{ color: "var(--muted)", flexShrink: 0, fontSize: 10 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          ) : (
            <div className="desktop-screenshot-empty">No console messages.</div>
          )}
        </div>
      )}
    </div>
  );
};

export default BrowserTab;
