import { useState } from "react";
import { isMobile } from "../../shared/api/api";
import { AUTH_EXPIRED_MESSAGE } from "../../shared/api/authFailure";
import { IClose } from "../../shared/ui/icons";
import { useStore } from "../../shared/model/store";
import { Button } from "../../shared/ui/ios/controls";

export default function SessionNotice() {
  const { authExpired, accountScope, loginOpen, setLoginOpen } = useStore();
  const [dismissedScope, setDismissedScope] = useState<string | null>(null);
  // Dismiss only this session's notice; keep expiry, cached records and sync guards.
  // A new login/account/line generation can show its own expiry notice again.
  const dismiss = () => setDismissedScope(accountScope);
  if (!authExpired || dismissedScope === accountScope) return null;
  return <aside hidden={loginOpen} aria-label="登录状态提示" className="fixed z-[75] inset-x-3 mx-auto max-w-lg rounded-(--r-md) border border-line bg-s2 p-3 shadow-xl"
    style={{ bottom: isMobile ? "calc(env(safe-area-inset-bottom, 0px) + 80px)" : 24 }}>
    <div className="flex items-start gap-2">
      <div role="alert" className="min-w-0 flex-1"><p className="font-semibold text-on">{AUTH_EXPIRED_MESSAGE}</p>
        <p className="mt-1 text-[13px] text-mut">可暂不登录继续浏览。收藏和观看记录已保留，重新登录后继续同步。</p></div>
      <Button className="ios-icon-button shrink-0" aria-label="关闭登录失效提示" onClick={dismiss}><IClose size={19} /></Button>
    </div>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button variant="primary" className="rounded-(--r-sm) px-4" style={{ minBlockSize: 44 }} onClick={() => setLoginOpen(true)}>重新登录</Button>
      <Button className="rounded-(--r-sm) px-4" style={{ minBlockSize: 44 }} onClick={dismiss}>暂不登录</Button>
    </div>
  </aside>;
}
