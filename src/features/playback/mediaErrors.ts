import { tr } from "../../shared/i18n";
import { isIos, isLinux } from "../../shared/api/api";
import Hls, { type ErrorData } from "hls.js";

/** Media/CDN authorization is not the account API's authentication state. Never expire a login here. */
export function hlsErrorMessage(data: ErrorData): string {
  const code = data.response?.code;
  if (code === 401 || code === 403) return tr("片源拒绝访问（HTTP {0}），播放地址可能已过期或受限，请重试或切换线路。", code);
  if (code === 404 || code === 410) return tr("片源不存在或已下线（HTTP {0}），请尝试其他集数或稍后重试。", code);
  if (code === 429) return tr("片源请求过于频繁（HTTP 429），请稍后重试。");
  if (code && code >= 500) return tr("片源服务暂时异常（HTTP {0}），请稍后重试或切换线路。", code);
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) return tr("视频网络请求失败，自动恢复未成功，请检查网络或切换线路后重试。");
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return tr("视频解码或缓冲失败，自动恢复未成功，请重试或尝试标准画质。");
  return tr("视频播放失败，请重试或尝试其他集数。");
}

export function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return tr("网络错误，视频加载失败，请检查网络后重试");
    case 3:
      return tr("视频解码失败，请重试");
    case 4:
      return isLinux
        ? tr("当前系统缺少 H.264/AAC 解码器，请安装 gstreamer1.0-libav 和 gstreamer1.0-plugins-bad 后重试")
        : isIos
          ? tr("视频资源加载失败或格式不受支持，请重试")
          : tr("当前视频格式不受支持");
    default:
      return tr("视频加载失败，请重试");
  }
}
