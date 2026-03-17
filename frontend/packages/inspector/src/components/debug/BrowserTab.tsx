import { ArrowLeft, ArrowRight, Globe, Loader2, Play, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SandboxAgentError } from "sandbox-agent";
import type { BrowserContextInfo, BrowserStatusResponse, SandboxAgent } from "sandbox-agent";
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
    </div>
  );
};

export default BrowserTab;
