import { tr } from "../../shared/i18n";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";

type Activity = { isActive: () => boolean; isPlayWanted: () => boolean };
type Recovery = { revision: number; retry: (source?: string, playWanted?: boolean) => void };
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

/** Bound silent stalls independently of engine error events. Only real clock progress resets the budget. */
export function usePlaybackWatchdog(videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>,
  src: string, activity: Activity, recovery: Recovery, onError: (message: string) => void,
  trace: (event: string, data?: Record<string, unknown>) => void) {
  const [status, setStatus] = useState("");
  const latest = useRef({ activity, recovery, onError, trace });
  latest.current = { activity, recovery, onError, trace };
  const state = useRef({ src: "", attempts: 0, automatic: false, terminal: false, networkError: false });

  const fail = useCallback((message: string) => {
    if (state.current.terminal) return;
    state.current.terminal = true;
    state.current.networkError = false;
    setStatus("");
    hlsRef.current?.stopLoad();
    videoRef.current?.pause();
    latest.current.onError(message);
  }, [videoRef, hlsRef]);
  const retry = useCallback(() => {
    if (latest.current.activity.isActive()) latest.current.recovery.retry("manual", true);
  }, []);
  const networkError = useCallback(() => { state.current.networkError = true; }, []);
  const isStopped = useCallback(() => state.current.terminal, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    const cycle = state.current;
    if (cycle.src !== src || !cycle.automatic) {
      cycle.attempts = 0;
      setStatus("");
    }
    cycle.src = src; cycle.automatic = false; cycle.terminal = false; cycle.networkError = false;
    let lastTime = video.currentTime;
    let elapsed = 0;
    let lastTick = performance.now();
    // Clear elapsed background time even if the WebView suspended every timer.
    const visibility = () => { elapsed = 0; lastTick = performance.now(); };
    // Seeking (including retry restoration) changes the clock without proving playback recovered.
    const seeked = () => { lastTime = video.currentTime; elapsed = 0; lastTick = performance.now(); };
    document.addEventListener("visibilitychange", visibility);
    video.addEventListener("seeked", seeked);
    const timer = window.setInterval(() => {
      const now = performance.now(), delta = now - lastTick;
      lastTick = now;
      if (cycle.terminal) return;
      const { activity, recovery, trace } = latest.current;
      if (!activity.isActive() || document.hidden || !activity.isPlayWanted() || video.ended
        || (video.paused && video.readyState >= 2 && !video.error)) {
        elapsed = 0; lastTime = video.currentTime;
        setStatus("");
        return;
      }
      if (!video.paused && !video.seeking && video.readyState >= 2 && video.currentTime > lastTime + 0.05) {
        elapsed = 0; lastTime = video.currentTime; cycle.attempts = 0; cycle.networkError = false;
        setStatus("");
        return;
      }
      elapsed += delta;
      if (elapsed < TIMEOUT_MS && !cycle.networkError) {
        if (elapsed >= 8_000 && cycle.attempts === 0) setStatus(tr("加载较慢，正在等待视频数据…"));
        return;
      }
      if (cycle.attempts >= MAX_RETRIES) {
        trace("loading.failed", { attempts: cycle.attempts, network_error: cycle.networkError });
        fail(cycle.networkError
          ? tr("视频网络连接失败，自动重试 2 次仍未恢复。请检查网络或切换线路后重试。")
          : tr("视频加载超时，自动重试 2 次仍无播放进展。可能是网络不稳定或片源响应慢，请重试或切换线路。"));
        return;
      }
      cycle.attempts++; cycle.automatic = true;
      setStatus(tr("视频加载中断，正在自动重试（{0}/{1}）…", cycle.attempts, MAX_RETRIES));
      trace("loading.retry", { attempt: cycle.attempts, time: video.currentTime });
      recovery.retry("loading_timeout");
      // The next effect owns the new connection; no second retry in this effect.
      cycle.terminal = true;
    }, 500);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      video.removeEventListener("seeked", seeked);
    };
  }, [src, recovery.revision, fail, videoRef]);

  return { status, fail, retry, networkError, isStopped };
}
