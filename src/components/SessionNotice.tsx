import { isMobile } from "../api";
import { AUTH_EXPIRED_MESSAGE } from "../authFailure";
import { useStore } from "../store";
import { Button } from "./ios/controls";

export default function SessionNotice() {
  const { authExpired, loginOpen, setLoginOpen } = useStore();
  if (!authExpired) return null;
  return <aside hidden={loginOpen} aria-label="登录状态提示" className="fixed z-[75] inset-x-3 mx-auto max-w-lg rounded-(--r-md) border border-line bg-s2 p-3 shadow-xl"
    style={{ bottom: isMobile ? "calc(env(safe-area-inset-bottom, 0px) + 80px)" : 24 }}>
    <div role="alert"><p className="font-semibold text-on">{AUTH_EXPIRED_MESSAGE}</p>
      <p className="mt-1 text-[13px] text-mut">收藏和观看记录已保留，重新登录后继续同步。</p></div>
    <Button variant="primary" className="mt-2 rounded-(--r-sm) px-4" style={{ minBlockSize: 44 }} onClick={() => setLoginOpen(true)}>重新登录</Button>
  </aside>;
}
