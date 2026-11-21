import { N_ } from "../i18n";

export const AUTH_EXPIRED_MESSAGE = N_("登录已失效，请重新登录");

// Only authenticated account operations can invalidate a session. A public
// content request or a failed password submission must not expire another login.
const ACCOUNT_COMMANDS = new Set([
  "api_me", "api_account_history", "api_account_history_record", "api_account_history_delete",
  "api_like", "api_collect", "api_follow", "api_post_like", "api_post_collect",
  "api_comment_send", "api_following",
]);
type Capture = (args?: Record<string, unknown>) => (() => boolean) | undefined;
let capture: Capture | undefined;

/** Capture the initiating account generation BEFORE dispatch, never at completion. */
export function captureAuthFailure(command: string, args?: Record<string, unknown>) {
  return ACCOUNT_COMMANDS.has(command) ? capture?.(args) : undefined;
}

export function observeAuthFailures(next: Capture) {
  capture = next;
  return () => { if (capture === next) capture = undefined; };
}

export function httpErrorStatus(message: string): string | undefined {
  return message === "401" ? "401" : /^HTTP (\d{3})\b/.exec(message)?.[1];
}
