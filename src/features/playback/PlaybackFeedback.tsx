import { tr } from "../../shared/i18n";
import { useEffect, useState } from "react";
import { AUTH_EXPIRED_MESSAGE } from "../../shared/api/authFailure";
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { IClose } from "../../shared/ui/icons";

/** A dismissible player notice, leaving navigation and video selection available. */
export function PlaybackFeedback({ error, waiting, status, onRetry, onLogin, onNetwork }: {
  error: string; waiting: boolean; status?: string;
  onRetry: () => void; onLogin?: () => void; onNetwork?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(false); }, [error]);
  if (error) return <div className={`absolute z-30 flex justify-center pointer-events-none ${collapsed ? "inset-x-2 top-2" : "inset-0 items-center p-3"}`}>
    <div className="relative max-w-sm rounded-xl bg-black/85 p-4 text-white text-center pointer-events-auto">
      {collapsed ? <Button className="min-h-11 px-3" onClick={() => setCollapsed(false)}>{tr("查看播放错误")}</Button> : <>
        <Button className="absolute right-0 top-0 min-h-11 min-w-11" aria-label={tr("关闭播放错误提示")} onClick={() => setCollapsed(true)}><IClose size={18} /></Button>
        <h2 className="px-8 text-[15px] font-bold">{tr("视频暂时无法加载")}</h2>
        <p role="alert" className="mt-3 text-[13px] leading-relaxed break-words">{tr(error)}</p>
      </>}
      <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
        {error === AUTH_EXPIRED_MESSAGE && onLogin && <Button className="min-h-11 px-3" onClick={onLogin}>{tr("重新登录")}</Button>}
        <Button className="min-h-11 px-3" onClick={onRetry}>{tr("重试")}</Button>
        {onNetwork && <Button className="min-h-11 px-3" onClick={onNetwork}>{tr("网络设置")}</Button>}
      </div>
    </div>
  </div>;
  if (!waiting) return null;
  return <div className="absolute inset-0 z-10 flex flex-col gap-3 items-center justify-center pointer-events-none text-white">
    <progress className="sr-only" aria-label={status || tr("正在加载视频")} />
    <Loader aria-hidden="true" className="w-9 h-9 spinner motion-reduce:animate-none" />
    {status && <p className="rounded-lg bg-black/70 px-3 py-2 text-[13px] text-center">{status}</p>}
  </div>;
}
