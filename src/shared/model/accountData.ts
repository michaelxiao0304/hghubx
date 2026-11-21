import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/api";
import type { AccountHistoryItem, AccountIdentity, AccountInteractions, User } from "../api/types";
import { AUTH_EXPIRED_MESSAGE, captureAuthFailure, observeAuthFailures } from "../api/authFailure";
import { accountKey, mergeRebasedAccounts } from "../storage/accountRebase";
import { favoriteChanges, historyRemovals, syncedFavorites, type FavoriteChanges } from "../storage/libraryChanges";
import { credentialFor, forgetCredential } from "./sessionCredential";
import type { WatchProgress } from "./store";
import { N_, tr } from "../i18n";

type Kind = "video" | "post";
export type GuestData = {
  likes: number[]; favs: number[]; follows: number[]; history: WatchProgress[];
  postLikes?: number[]; postFavs?: number[];
  likeEpisodes?: { video_id: number; ep: number }[];
  localHistory?: number[];
  favEpCounts?: Record<number, number>;
};

/** Share one library-only boundary without losing guest post or episode interactions. */
export function pickGuestData(data: GuestData): GuestData {
  return { likes: data.likes, favs: data.favs, follows: data.follows, history: data.history,
    postLikes: data.postLikes, postFavs: data.postFavs, likeEpisodes: data.likeEpisodes,
    localHistory: data.localHistory, favEpCounts: data.favEpCounts };
}
export type AccountData = GuestData & {
  postLikes: number[]; postFavs: number[];
  likeEpisodes?: { video_id: number; ep: number }[];
  favoriteChanges?: FavoriteChanges;
  postFavoriteChanges?: FavoriteChanges;
  historyRemovedAt?: Record<number, number>;
  dirtyHistory: Record<number, { ep: number; at: number }>;
  localHistory: number[];
};
type SyncState = { busy: boolean; error: string; lastSynced: number; favoritesKnown: boolean };
const ACCOUNT_KEY = "hghubx_accounts_v1";
const PENDING_LINE = N_("登录信息已保留，正在等待验证线路。恢复连接后会自动同步。");
const empty = (): AccountData => ({ likes: [], favs: [], follows: [], history: [], postLikes: [], postFavs: [], dirtyHistory: {}, localHistory: [] });
const ids = (value: unknown): number[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0))] : [];
const validProgress = (value: unknown): value is WatchProgress => {
  const row = value as WatchProgress | null;
  return !!row && Number.isSafeInteger(row.id) && row.id > 0 && Number.isFinite(row.at)
    && Number.isSafeInteger(row.ep) && row.ep > 0 && Number.isFinite(row.t) && row.t >= 0 && Number.isFinite(row.dur) && row.dur >= 0;
};
function sanitizeEpCounts(raw: Record<number, number> | undefined, favIds: number[]): Record<number, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const favSet = new Set(favIds);
  const entries = Object.entries(raw).filter(([id, count]) => {
    const numId = Number(id);
    return favSet.has(numId) && Number.isSafeInteger(count) && count > 0;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
function sanitize(value: Partial<AccountData> | null | undefined): AccountData {
  const data = { ...empty(), ...value };
  const favs = ids(data.favs);
  // Account snapshots must never retain unrelated application preferences.
  return { likes: ids(data.likes), favs, follows: ids(data.follows), postLikes: ids(data.postLikes), postFavs: ids(data.postFavs),
    history: Array.isArray(data.history) ? data.history.filter(validProgress) : [], localHistory: ids(data.localHistory),
    likeEpisodes: Array.isArray(data.likeEpisodes) ? data.likeEpisodes.filter(row => Number.isSafeInteger(row?.video_id) && row.video_id > 0 && Number.isSafeInteger(row.ep) && row.ep > 0) : undefined,
    favoriteChanges: favoriteChanges(data.favoriteChanges), postFavoriteChanges: favoriteChanges(data.postFavoriteChanges),
    historyRemovedAt: historyRemovals(data.historyRemovedAt),
    favEpCounts: sanitizeEpCounts(data.favEpCounts, favs),
    dirtyHistory: Object.fromEntries(Object.entries(data.dirtyHistory || {}).filter(([id, row]) => Number.isSafeInteger(Number(id)) && Number(id) > 0 && Number.isSafeInteger(row?.ep) && row.ep > 0 && Number.isFinite(row.at))),
  };
}
const selected = (list: number[], id: number, on: boolean) => on ? [id, ...list.filter(x => x !== id)] : list.filter(x => x !== id);
const message = (error: unknown) => error instanceof Error ? error.message : tr("账号同步失败，请重试");
function applyInteractions(data: AccountData, incoming?: AccountInteractions, origin = ""): AccountData {
  if (!incoming) return data;
  const next = { ...data };
  for (const [local, remote] of [["likes", "like_video_ids"], ["favs", "favorite_video_ids"], ["follows", "follow_user_ids"], ["postLikes", "like_post_ids"], ["postFavs", "favorite_post_ids"]] as const) {
    if (!Array.isArray(incoming[remote])) continue;
    const values = ids(incoming[remote]);
    if (local === "favs" || local === "postFavs") {
      const field = local === "favs" ? "favoriteChanges" : "postFavoriteChanges";
      const synced = syncedFavorites(values, next[field], origin);
      next[local] = synced.ids;
      next[field] = synced.changes;
    } else next[local] = values;
  }
  if (Array.isArray(incoming.favorite_video_ids)) next.favEpCounts = sanitizeEpCounts(next.favEpCounts, next.favs);
  if (Array.isArray(incoming.like_video_episodes)) next.likeEpisodes = sanitize({ likeEpisodes: incoming.like_video_episodes }).likeEpisodes;
  return next;
}

/** Separate guest/account caches. Async responses may commit only to their initiating session. */
export function useAccountData(initialGuest: GuestData, saveGuest: (data: GuestData) => void) {
  const [drawTick, redraw] = useState(0);
  const snapshotRevision = useRef(0);
  const render = () => { snapshotRevision.current++; redraw(n => n + 1); };
  const mounted = useRef(true);
  const saveGuestRef = useRef(saveGuest); saveGuestRef.current = saveGuest;
  const state = useRef<{ user: User | null; origin: string; key: string; generation: number; authExpired: boolean; awaitingTrust: boolean; data: AccountData; sync: SyncState } | null>(null);
  const accounts = useRef<Record<string, AccountData>>({});
  const aliases = useRef<Record<string, string>>({});
  const guest = useRef(sanitize(initialGuest));
  if (!state.current) {
    try {
      const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "{}");
      if (saved.version === 1 && saved.accounts && typeof saved.accounts === "object") {
        accounts.current = Object.fromEntries(Object.entries(saved.accounts).map(([key, data]) => [key, sanitize(data as AccountData)]));
        if (saved.aliases && typeof saved.aliases === "object") {
          aliases.current = Object.fromEntries(Object.entries(saved.aliases).filter((entry): entry is [string, string] =>
            typeof entry[1] === "string" && !!accounts.current[entry[1]]));
        }
      }
    } catch { /* A damaged account cache must not erase legacy guest records. */ }
    state.current = { user: null, origin: "", key: "guest", generation: 0, authExpired: false, awaitingTrust: false, data: guest.current, sync: { busy: false, error: "", lastSynced: 0, favoritesKnown: false } };
  }
  const pending = useRef(new Map<string, Promise<void>>());
  const mutation = useRef(0);
  const historyMutation = useRef(0);
  const clearVersion = useRef(0);
  const storageError = useRef("");
  const needsResync = useRef(false);
  const synchronizing = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const upload = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const sentHistory = useRef(new Map<number, number>());
  const clearing = useRef<number | null>(null);
  const flushTimer = useRef<number | undefined>(undefined);
  const syncTimer = useRef<number | undefined>(undefined);
  const isCurrent = (generation: number) => mounted.current && state.current!.generation === generation;
  const canSync = (generation: number) => isCurrent(generation) && !state.current!.authExpired && !state.current!.awaitingTrust;
  useLayoutEffect(() => observeAuthFailures(args => {
    const { user, origin, generation } = state.current!;
    if (!user || !origin) return;
    if (state.current!.awaitingTrust) return () => false;
    if ((args?.expectedUserId != null && args.expectedUserId !== user.id)
      || (args?.expectedOrigin != null && args.expectedOrigin !== origin)) return () => false;
    return () => {
      if (!isCurrent(generation)) return false;
      const s = state.current!;
      if (s.authExpired) return true;
      // Keep the account identity and its library visible. Expiry is NOT logout:
      // never clear guest/account storage or move records between the two scopes.
      forgetCredential();
      s.authExpired = true;
      s.sync = { ...s.sync, busy: false, error: AUTH_EXPIRED_MESSAGE };
      window.clearTimeout(flushTimer.current); flushTimer.current = undefined;
      window.clearTimeout(syncTimer.current);
      pending.current.clear(); needsResync.current = false;
      render();
      return true;
    };
  }), []);
  const identity = (): AccountIdentity => {
    const s = state.current!;
    if (s.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
    if (s.awaitingTrust) throw new Error(PENDING_LINE);
    if (!s.user || !s.origin) throw new Error(tr("请先登录当前线路的账号"));
    return { expectedUserId: s.user.id, expectedOrigin: s.origin };
  };
  const persist = (data: AccountData, silent = false) => {
    const s = state.current!;
    s.data = data;
    if (!s.user) {
      guest.current = data;
      snapshotRevision.current++;
      saveGuestRef.current(pickGuestData(data));
      return;
    }
    accounts.current[accountKey(aliases.current, s.key)] = data;
    let storageFailed = false;
    try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ version: 1, accounts: accounts.current, aliases: aliases.current })); storageError.current = ""; }
    catch { storageError.current = tr("本机账号缓存保存失败，请检查存储空间"); s.sync = { ...s.sync, error: storageError.current }; storageFailed = true; }
    if (mounted.current && (!silent || storageFailed)) render();
  };
  const flushHistory = async () => {
    const generation = state.current!.generation;
    if (!state.current!.user || !canSync(generation) || clearing.current === generation) return;
    if (upload.current?.generation === generation) return upload.current.promise;
    const auth = identity();
    const run = (async () => {
      for (const [key, row] of Object.entries(state.current!.data.dirtyHistory)) {
        if (!canSync(generation) || clearing.current === generation) return;
        const id = Number(key);
        await api.accountHistoryRecord(auth, id, row.ep);
        if (!canSync(generation)) return;
        sentHistory.current.set(id, row.ep);
        const current = state.current!.data;
        if (current.dirtyHistory[id]?.at === row.at) {
          const dirtyHistory = { ...current.dirtyHistory }; delete dirtyHistory[id];
          persist({ ...current, dirtyHistory }, true);
        }
      }
    })();
    upload.current = { generation, promise: run };
    try {
      await run;
      // A timer firing while an upload was in flight joined that upload. Drain new entries afterwards.
      if (canSync(generation) && Object.keys(state.current!.data.dirtyHistory).length) scheduleUpload(generation);
    } finally { if (upload.current?.promise === run) upload.current = null; }
  };
  function scheduleUpload(generation: number) {
    if (!canSync(generation) || flushTimer.current || clearing.current === generation) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = undefined;
      if (canSync(generation)) void flushHistory().catch(error => {
        if (canSync(generation)) { state.current!.sync = { ...state.current!.sync, error: tr("观看历史待同步：{0}", message(error)) }; render(); }
      });
    }, 1500);
  }
  const readHistory = async (auth: AccountIdentity, generation: number, deferExpiry = false) => {
    const rows: AccountHistoryItem[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 200; page++) {
      const result = await api.accountHistory(auth, page, 100, deferExpiry);
      if (!isCurrent(generation)) throw new Error(tr("账号已切换"));
      if (state.current!.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
      if (!result || !Array.isArray(result.items) || !result.pagination || result.pagination.page !== page
        || !Number.isInteger(result.pagination.pages) || result.pagination.pages < 0 || result.pagination.pages > 200) throw new Error(tr("账号历史返回格式异常"));
      for (const row of result.items) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
      if (page >= result.pagination.pages) return rows;
    }
    throw new Error(tr("账号历史分页过多，请稍后重试"));
  };
  const recoveryGeneration = useRef<number | null>(null);
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const syncAccount = useCallback(async () => {
    const s = state.current!;
    if (!s.user) return;
    if (s.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
    const generation = s.generation;
    if (synchronizing.current?.generation === generation) return synchronizing.current.promise;
    if (clearing.current === generation) return;
    const auth = identity();
    s.sync = { ...s.sync, busy: true, error: "" }; render();
    const startMutation = mutation.current;
    const startClear = clearVersion.current;
    const startHistory = new Map(s.data.history.map(row => [row.id, row]));
    const run = (async () => {
      // Only replay observed playback, never silently upload the guest's library.
      const credential = recoveryGeneration.current === generation ? null : credentialFor(auth.expectedUserId);
      const expire = captureAuthFailure("api_me", { ...auth });
      const load = (deferExpiry: boolean) => Promise.allSettled([
        api.me(auth, deferExpiry),
        (async () => { await flushHistory(); return readHistory(auth, generation, deferExpiry); })(),
      ] as const);
      let [profile, remote] = await load(!!credential);
      if (!isCurrent(generation)) return;
      if (s.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
      if (credential && [profile, remote].some(result =>
        result.status === "rejected" && message(result.reason) === AUTH_EXPIRED_MESSAGE)) {
        recoveryGeneration.current = generation;
        try {
          const snapshot = await api.login(credential.username, credential.password, { ...auth, credentialOrigin: credential.origin });
          if (!canSync(generation)) return;
          if (snapshot.origin !== auth.expectedOrigin || snapshot.user?.id !== auth.expectedUserId) throw new Error("登录身份已变化");
        } catch {
          if (!isCurrent(generation)) return;
          expire?.();
          throw new Error(AUTH_EXPIRED_MESSAGE);
        }
        [profile, remote] = await load(false);
        if (!isCurrent(generation)) return;
        if (s.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
      }
      let current = state.current!.data;
      let favoritesKnown = state.current!.sync.favoritesKnown;
      const errors: string[] = [];
      if (profile.status === "fulfilled") {
        const snapshot = profile.value;
        if (snapshot?.origin !== auth.expectedOrigin || snapshot.user?.id !== auth.expectedUserId) errors.push(tr("账号资料身份不匹配，请重新登录"));
        else if (mutation.current === startMutation && pending.current.size === 0) {
          state.current!.user = snapshot.user;
          current = applyInteractions(current, snapshot.interactions, auth.expectedOrigin);
          if (Array.isArray(snapshot.interactions?.favorite_video_ids)) favoritesKnown = true;
          else if (!favoritesKnown) errors.push(tr("账号未返回收藏数据，请重试"));
        } else if (pending.current.size === 0) needsResync.current = true;
      } else errors.push(message(profile.reason));
      if (remote.status === "fulfilled" && clearVersion.current === startClear) {
        const localRows = new Map(current.history.map(row => [row.id, row]));
        const changed = (row: WatchProgress) => startHistory.get(row.id) !== row;
        const localOnly = new Set(current.localHistory);
        const merged = new Map(current.history.filter(row => localOnly.has(row.id) || current.dirtyHistory[row.id] || changed(row)).map(row => [row.id, row]));
        for (const row of remote.value) {
          if (row.target_type !== "video" || !Number.isSafeInteger(row.video_id) || row.video_id <= 0) continue;
          const local = localRows.get(row.video_id);
          const timestamp = Date.parse(row.updated_at.replace(" ", "T")) || 0;
          const removedAt = current.historyRemovedAt?.[row.video_id];
          if (removedAt && timestamp <= removedAt) continue;
          const ep = Math.max(1, row.last_ep || 1);
          if (!local || (timestamp > local.at && !current.dirtyHistory[row.video_id] && !changed(local))) {
            merged.set(row.video_id, { id: row.video_id, ep, t: local?.ep === ep ? local.t : 0, dur: local?.ep === ep ? local.dur : 0, at: timestamp });
          } else merged.set(row.video_id, local);
          if (!current.dirtyHistory[row.video_id] && (!local || !changed(local))) localOnly.delete(row.video_id);
        }
        current = { ...current, history: [...merged.values()].sort((a, b) => b.at - a.at), localHistory: [...localOnly] };
      } else if (remote.status === "rejected") errors.push(message(remote.reason));
      persist(current);
      if (storageError.current) errors.push(storageError.current);
      state.current!.sync = { busy: false, error: errors.join("；"), lastSynced: errors.length ? s.sync.lastSynced : Date.now(), favoritesKnown };
      render();
      if (errors.length) throw new Error(errors.join("；"));
    })();
    synchronizing.current = { generation, promise: run };
    try { await run; } finally {
      if (synchronizing.current?.promise === run) synchronizing.current = null;
      if (canSync(generation) && needsResync.current) {
        needsResync.current = false;
        window.clearTimeout(syncTimer.current);
        syncTimer.current = window.setTimeout(() => { if (canSync(generation)) void syncRef.current().catch(() => {}); }, 500);
      }
    }
  }, []);
  syncRef.current = syncAccount;
  const retrySync = useCallback(async () => {
    if (state.current!.awaitingTrust) window.dispatchEvent(new Event("hg:session-retry"));
    else await syncAccount();
  }, [syncAccount]);
  const switchSession = useCallback((user: User | null, origin?: string, restored = false, awaitingTrust = false, libraryOrigin?: string | null) => {
    const s = state.current!;
    const nextOrigin = origin ?? s.origin;
    const next = user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
    const key = next ? JSON.stringify([nextOrigin, next.id]) : "guest";
    const sameAccount = restored && next && s.user?.id === next.id;
    const expired = !!sameAccount && s.authExpired;
    const sourceOrigin = libraryOrigin ?? (sameAccount ? s.origin : undefined);
    storageError.current = "";
    if (restored && next && sourceOrigin && sourceOrigin !== nextOrigin && (!awaitingTrust || libraryOrigin)) {
      const sourceKey = accountKey(aliases.current, JSON.stringify([sourceOrigin, next.id]));
      const targetKey = accountKey(aliases.current, key);
      if (sourceKey !== targetKey) {
        const source = sameAccount ? s.data : accounts.current[sourceKey];
        // Boot, not an arbitrary same-ID login, authorizes a cross-origin merge.
        // Persist data and aliases together; failed writes leave the old disk
        // value intact and the in-memory merge is retried by the next persist.
        const target = accounts.current[targetKey];
        accounts.current[targetKey] = source ? mergeRebasedAccounts(source, target) : target ?? applyInteractions(empty(), next.interactions);
        aliases.current[sourceKey] = targetKey;
        try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ version: 1, accounts: accounts.current, aliases: aliases.current })); }
        catch { storageError.current = "本机账号缓存保存失败，请检查存储空间"; }
      }
    }
    window.clearTimeout(flushTimer.current); flushTimer.current = undefined;
    window.clearTimeout(syncTimer.current);
    s.generation++; mutation.current++; historyMutation.current++;
    if (!next || !credentialFor(next.id)) forgetCredential();
    s.user = next; s.origin = nextOrigin; s.key = key;
    s.authExpired = expired;
    s.awaitingTrust = awaitingTrust;
    s.data = next ? accounts.current[accountKey(aliases.current, key)] || applyInteractions(empty(), next.interactions) : guest.current;
    s.sync = { busy: false, error: storageError.current || (expired ? AUTH_EXPIRED_MESSAGE : awaitingTrust ? PENDING_LINE : ""), lastSynced: 0, favoritesKnown: false };
    sentHistory.current.clear(); pending.current.clear(); needsResync.current = false;
    render();
    if (next && !expired && !awaitingTrust) void syncRef.current().catch(() => {});
  }, []);
  const setUser = useCallback((user: User | null, origin?: string) => switchSession(user, origin), [switchSession]);
  const generation = useCallback(() => state.current!.generation, []);
  const restoreSession = useCallback((user: User | null, origin: string, expectedGeneration: number, awaitingTrust: boolean, libraryOrigin?: string | null) => {
    if (!isCurrent(expectedGeneration)) return;
    if (!user && !state.current!.user) { state.current!.origin = origin; return; }
    // 同一账号同一线路的重复 boot（切线后 rebase 成功）不重置 generation/同步状态。
    const s = state.current!;
    if (user && s.user && s.user.id === user.id && s.origin === origin && s.awaitingTrust === awaitingTrust) return;
    switchSession(user, origin, true, awaitingTrust, libraryOrigin);
  }, [switchSession]);
  const logout = useCallback(async () => {
    const { generation: version, user, origin } = state.current!;
    // Logout clears the local session even when its token has expired. Retain
    // identity matching and generation guards without requiring a valid token.
    await api.logout(user ? { expectedUserId: user.id, expectedOrigin: origin } : undefined);
    if (!isCurrent(version)) throw new Error(tr("账号已切换"));
    setUser(null);
  }, [setUser]);
  const mutate = (key: string, request: (auth: AccountIdentity) => Promise<unknown>, update: (data: AccountData) => AccountData) => {
    const s = state.current!;
    const version = s.generation;
    if (pending.current.has(key)) return pending.current.get(key)!;
    mutation.current++;
    const run = (async () => {
      if (s.user) await request(identity());
      if (!isCurrent(version)) throw new Error(tr("账号已切换，原操作不会影响当前账号"));
      if (state.current!.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
      mutation.current++;
      persist(update(state.current!.data));
    })();
    pending.current.set(key, run); render();
    void run.finally(() => {
      if (isCurrent(version) && pending.current.get(key) === run) {
        pending.current.delete(key); render();
        // Pending writes own their follow-up refresh; a slow write must not make sync poll every 500ms.
        if (state.current!.user && canSync(version)) {
          window.clearTimeout(syncTimer.current);
          syncTimer.current = window.setTimeout(() => { if (canSync(version)) void syncRef.current().catch(() => {}); }, 500);
        }
      }
    }).catch(() => {});
    return run;
  };
  const setCollected = useCallback((kind: Kind, id: number, on: boolean, knownEpisodes?: number) => mutate(`collect:${kind}:${id}`,
    auth => kind === "video" ? api.collect(id, on, auth) : api.postCollect(id, on, auth),
    data => {
      const field = kind === "video" ? "favoriteChanges" : "postFavoriteChanges";
      const edits = state.current!.user ? { [field]: { ...data[field], [id]: { on, at: Date.now(), origin: state.current!.origin } } } : {};
      if (kind !== "video") return { ...data, ...edits, postFavs: selected(data.postFavs, id, on) };
      const favs = selected(data.favs, id, on);
      const nextCounts = { ...(data.favEpCounts || {}) };
      if (!on) delete nextCounts[id];
      else if (knownEpisodes && Number.isSafeInteger(knownEpisodes) && knownEpisodes > 0) nextCounts[id] = knownEpisodes;
      return { ...data, ...edits, favs, favEpCounts: sanitizeEpCounts(nextCounts, favs) };
    }), []);
  const setLiked = useCallback((kind: Kind, id: number, ep: number, on: boolean) => mutate(`like:${kind}:${id}:${ep}`,
    auth => kind === "video" ? api.like(id, ep, on, auth) : api.postLike(id, on, auth), data => {
      if (kind === "post") return { ...data, postLikes: selected(data.postLikes, id, on) };
      const likeEpisodes = (data.likeEpisodes || data.likes.map(video_id => ({ video_id, ep: 1 }))).filter(row => row.video_id !== id || row.ep !== ep);
      if (on) likeEpisodes.push({ video_id: id, ep });
      return { ...data, likeEpisodes, likes: selected(data.likes, id, likeEpisodes.some(row => row.video_id === id)) };
    }), []);
  const setFollowing = useCallback((id: number, on: boolean) => {
    if (!state.current!.user) return Promise.reject(new Error(tr("请先登录")));
    return mutate(`follow:${id}`, auth => api.follow(id, on, auth), data => ({ ...data, follows: selected(data.follows, id, on) }));
  }, []);
  const currentGeneration = state.current.generation;
  const currentClearVersion = clearVersion.current;
  const addHistory = useCallback((id: number, ep?: number, time?: number, duration?: number) => {
    if (!isCurrent(currentGeneration) || clearVersion.current !== currentClearVersion || !Number.isSafeInteger(id) || id <= 0) return;
    const s = state.current!;
    if (clearing.current === currentGeneration) return;
    const previous = s.data.history.find(row => row.id === id);
    const nextEp = ep ?? previous?.ep ?? 1;
    const changed = previous && previous.ep !== nextEp;
    const row: WatchProgress = { id, ep: nextEp, t: time ?? (changed ? 0 : previous?.t ?? 0), dur: duration ?? (changed ? 0 : previous?.dur ?? 0), at: Date.now() };
    if (!validProgress(row)) return;
    const removedAt = s.data.historyRemovedAt?.[id];
    if (removedAt) row.at = Math.max(row.at, removedAt + 1);
    historyMutation.current++;
    let dirtyHistory = s.data.dirtyHistory;
    if (s.user && time !== undefined && time >= 3 && sentHistory.current.get(id) !== nextEp && dirtyHistory[id]?.ep !== nextEp) {
      dirtyHistory = { ...dirtyHistory, [id]: { ep: nextEp, at: row.at } };
    }
    let favEpCounts = s.data.favEpCounts;
    if (s.data.favs.includes(id) && favEpCounts?.[id] !== undefined && nextEp > favEpCounts[id]) {
      favEpCounts = { ...favEpCounts, [id]: nextEp };
    }
    persist({ ...s.data, history: [row, ...s.data.history.filter(item => item.id !== id)], dirtyHistory, localHistory: selected(s.data.localHistory, id, true), favEpCounts });
    if (s.user && Object.keys(dirtyHistory).length) scheduleUpload(currentGeneration);
  }, [currentGeneration, currentClearVersion]);
  const deleteHistory = useCallback(async (videoIds?: number[]) => {
    const selectedIds = videoIds && new Set(videoIds.filter(id => Number.isSafeInteger(id) && id > 0));
    if (selectedIds?.size === 0) return;
    const version = state.current!.generation;
    if (clearing.current === version) {
      if (!selectedIds) return;
      throw new Error(tr("另一项观看记录操作正在进行，请稍后重试"));
    }
    clearing.current = version;
    historyMutation.current++; clearVersion.current++;
    render();
    window.clearTimeout(flushTimer.current); flushTimer.current = undefined;
    const data = state.current!.data;
    const targetIds = selectedIds ?? new Set([...data.history.map(row => row.id), ...data.localHistory, ...Object.keys(data.dirtyHistory).map(Number)]);
    const remoteTimes = new Map<number, number>();
    const commitRemoved = (ids: number[]) => {
      const current = state.current!.data;
      const removed = new Set(ids);
      const historyRemovedAt = { ...current.historyRemovedAt };
      const now = Date.now();
      for (const id of removed) {
        sentHistory.current.delete(id);
        if (state.current!.user) historyRemovedAt[id] = Math.max(now, historyRemovedAt[id] || 0, remoteTimes.get(id) || 0);
      }
      for (const row of current.history) {
        if (removed.has(row.id) && state.current!.user) historyRemovedAt[row.id] = Math.max(historyRemovedAt[row.id], row.at);
      }
      historyMutation.current++; clearVersion.current++;
      persist({ ...current, historyRemovedAt, history: current.history.filter(row => !removed.has(row.id)),
        dirtyHistory: Object.fromEntries(Object.entries(current.dirtyHistory).filter(([id]) => !removed.has(+id))),
        localHistory: current.localHistory.filter(id => !removed.has(id)) });
    };
    try {
      if (!state.current!.user) { commitRemoved([...targetIds]); return; }
      if (synchronizing.current?.generation === version) await synchronizing.current.promise.catch(() => {});
      if (!isCurrent(version)) throw new Error(tr("账号已切换"));
      if (upload.current?.generation === version) await upload.current.promise.catch(() => {});
      if (!isCurrent(version)) throw new Error(tr("账号已切换"));
      const auth = identity();
      const rows = (await readHistory(auth, version)).filter(row => row.target_type === "video" && (!selectedIds || selectedIds.has(row.video_id)));
      if (!isCurrent(version)) throw new Error(tr("账号已切换"));
      if (state.current!.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
      const remaining = new Map<number, number>();
      for (const row of rows) {
        targetIds.add(row.video_id);
        remaining.set(row.video_id, (remaining.get(row.video_id) || 0) + 1);
        const at = Date.parse(row.updated_at.replace(" ", "T")) || 0;
        remoteTimes.set(row.video_id, Math.max(at, remoteTimes.get(row.video_id) || 0));
      }
      const localOnly = [...targetIds].filter(id => !remaining.has(id));
      if (localOnly.length) commitRemoved(localOnly);
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        await api.accountHistoryDelete(auth, batch.map(row => row.id));
        if (!isCurrent(version)) throw new Error(tr("账号已切换"));
        if (state.current!.authExpired) throw new Error(AUTH_EXPIRED_MESSAGE);
        const confirmed = [];
        for (const row of batch) {
          const left = remaining.get(row.video_id)! - 1;
          remaining.set(row.video_id, left);
          if (!left) confirmed.push(row.video_id);
        }
        if (confirmed.length) commitRemoved(confirmed);
      }
    } finally {
      if (clearing.current === version) clearing.current = null;
      if (isCurrent(version) && state.current!.user && Object.keys(state.current!.data.dirtyHistory).length) scheduleUpload(version);
    }
  }, []);
  const clearHistory = useCallback(() => deleteHistory(), [deleteHistory]);
  const removeHistory = useCallback((ids: number[]) => deleteHistory(ids), [deleteHistory]);
  const seedFavoriteEpisodes = useCallback((entries: Record<number, number>) => {
    const cur = state.current!.data;
    const favSet = new Set(cur.favs);
    const nextCounts = { ...(cur.favEpCounts || {}) };
    let changed = false;
    for (const [rawId, count] of Object.entries(entries)) {
      const id = Number(rawId);
      if (!favSet.has(id) || nextCounts[id] !== undefined || !Number.isSafeInteger(count) || count <= 0) continue;
      nextCounts[id] = count;
      changed = true;
    }
    if (changed) persist({ ...cur, favEpCounts: sanitizeEpCounts(nextCounts, cur.favs) });
  }, []);
  const ackFavoriteEpisodes = useCallback((id: number, knownEpisodes: number) => {
    const cur = state.current!.data;
    if (!cur.favs.includes(id) || !Number.isSafeInteger(knownEpisodes) || knownEpisodes <= 0) return;
    if ((cur.favEpCounts?.[id] ?? 0) >= knownEpisodes) return;
    persist({ ...cur, favEpCounts: sanitizeEpCounts({ ...(cur.favEpCounts || {}), [id]: knownEpisodes }, cur.favs) });
  }, []);
  const localToggle = useCallback((field: "likes" | "favs" | "follows", id: number) => {
    const on = !state.current!.data[field].includes(id); mutation.current++;
    const nextList = selected(state.current!.data[field], id, on);
    const favEpCounts = field === "favs" ? sanitizeEpCounts(state.current!.data.favEpCounts, nextList) : state.current!.data.favEpCounts;
    persist({ ...state.current!.data, [field]: nextList, favEpCounts }); return on;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => { if (document.visibilityState !== "hidden") void syncRef.current().catch(() => {}); };
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { mounted.current = false; window.clearTimeout(flushTimer.current); window.clearTimeout(syncTimer.current);
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const s = state.current;
  const rev = snapshotRevision.current;
  return useMemo(() => ({
    user: s.user, authExpired: s.authExpired, setUser, restoreSession, generation, logout, accountScope: `${s.key}:${s.generation}`, accountSync: s.sync,
    syncAccount: retrySync, likes: s.data.likes, favs: s.data.favs, postLikes: s.data.postLikes, postFavs: s.data.postFavs, follows: s.data.follows, history: s.data.history,
    favEpCounts: s.data.favEpCounts || {}, seedFavoriteEpisodes, ackFavoriteEpisodes,
    isFav: (id: number, kind: Kind = "video") => (kind === "video" ? s.data.favs : s.data.postFavs).includes(id),
    isLiked: (id: number, ep?: number, kind: Kind = "video") => kind === "post" ? s.data.postLikes.includes(id)
      : ep !== undefined && s.data.likeEpisodes ? s.data.likeEpisodes.some(row => row.video_id === id && row.ep === ep) : s.data.likes.includes(id),
    setCollected, setLiked, setFollowing, addHistory, clearHistory, removeHistory,
    actionPending: (key: string) => pending.current.has(key),
    toggleLikeLocal: (id: number) => localToggle("likes", id),
    toggleFavLocal: (id: number) => localToggle("favs", id),
    toggleFollowLocal: (id: number) => localToggle("follows", id),
  }), [rev, drawTick, setUser, restoreSession, generation, logout, retrySync, seedFavoriteEpisodes, ackFavoriteEpisodes, setCollected, setLiked, setFollowing, addHistory, clearHistory, removeHistory, localToggle]);
}
