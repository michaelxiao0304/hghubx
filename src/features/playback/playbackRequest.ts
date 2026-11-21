import { tr } from "../../shared/i18n";

/** A stalled IPC must not retain the feed's single-flight entry forever. Late results are ignored. */
export function playbackRequest<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(tr("获取播放地址超时，请检查网络或切换线路后重试"))), 30_000);
    request.then(resolve, reject).finally(() => window.clearTimeout(timeout));
  });
}
