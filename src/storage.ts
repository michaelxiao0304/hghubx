export const STORAGE_KEYS = {
  app: "hghubx_app_v1",
  swipeEp: "hghubx_swipe_ep_v2",
  theme: "hghubx_theme",
  autoLine: "hghubx_auto_line",
} as const;

type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];

const FORK_LIBRARY = "app_data_v1:default:library";
const LIBRARY_BACKUP = "hghubx_library_backup_v2";
const MIGRATION_VERSION = 2;
type Library = Record<string, unknown>;

function parseLibrary(raw: string | null): Library | null {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Library : null;
  } catch { return null; }
}

function mergeLibraries(base: Library, fork: Library): Library {
  const result: Library = { ...base, ...fork, _libraryMigration: MIGRATION_VERSION };
  for (const key of ["likes", "favs", "follows", "searchHist"]) {
    const items = [fork[key], base[key]].flatMap(value => Array.isArray(value) ? value : []);
    result[key] = [...new Set(items.filter(value => key === "searchHist"
      ? typeof value === "string" : typeof value === "number" && Number.isSafeInteger(value) && value > 0))];
  }
  const history = new Map<number, Record<string, number>>();
  const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  for (const source of [fork.history, base.history]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const value = typeof item === "number" ? { id: item } : item;
      if (!value || !Number.isSafeInteger(value.id) || value.id <= 0) continue;
      const entry = { id: value.id, ep: Math.max(1, number(value.ep, 1)), t: number(value.t), dur: number(value.dur), at: number(value.at) };
      const previous = history.get(entry.id);
      // Timestamp wins, then the fork on ties; legacy number[] must not erase progress.
      if (!previous || entry.at > previous.at) history.set(entry.id, entry);
    }
  }
  result.history = [...history.values()].sort((a, b) => b.at - a.at);
  return result;
}

function readLibrary(): string | null {
  const currentRaw = localStorage.getItem(STORAGE_KEYS.app);
  const current = parseLibrary(currentRaw);
  // The marker travels with the state in ONE atomic setItem. Retained backups
  // must never resurrect a favourite/history item the user subsequently deleted.
  if (current?._libraryMigration === MIGRATION_VERSION) return currentRaw;
  const forkRaw = localStorage.getItem(FORK_LIBRARY);
  const legacyRaw = localStorage.getItem("hghub_app_v1");
  if (forkRaw === null && legacyRaw === null) return currentRaw;
  const legacy = parseLibrary(legacyRaw);
  const fork = parseLibrary(forkRaw);
  const baseline = current ?? legacy;
  if (!baseline && !fork) return currentRaw ?? legacyRaw;
  const merged = JSON.stringify(mergeLibraries(baseline ?? {}, fork ?? {}));
  const originals = Object.fromEntries([
    [STORAGE_KEYS.app, currentRaw], [FORK_LIBRARY, forkRaw], ["hghub_app_v1", legacyRaw],
  ].filter(([, value]) => value !== null));
  try {
    if (localStorage.getItem(LIBRARY_BACKUP) === null) {
      localStorage.setItem(LIBRARY_BACKUP, JSON.stringify({ version: MIGRATION_VERSION, originals }));
    }
    writeAppStorage(JSON.parse(merged));
  } catch { /* Read the merged state in memory; keep every original for a later retry. */ }
  return merged;
}

/** A backup must exist before the store can overwrite pre-migration app state. */
export function writeAppStorage(state: unknown): void {
  if ((state as Library)?._libraryMigration === MIGRATION_VERSION) {
    const backup = parseLibrary(localStorage.getItem(LIBRARY_BACKUP));
    if (backup?.version !== MIGRATION_VERSION || !backup.originals) return;
  }
  localStorage.setItem(STORAGE_KEYS.app, JSON.stringify(state));
}

// 旧名称仅用于升级迁移，运行期始终向 HGhubX 的键写入。
const LEGACY_KEYS: Record<StorageKey, string> = {
  hghubx_app_v1: "hghub_app_v1",
  hghubx_swipe_ep_v2: "hghub_swipe_ep_v2",
  hghubx_theme: "hghub_theme",
  hghubx_auto_line: "hg.autoLine",
};

/** 新键优先；确认旧数据已写入新键后才删除旧键。存储写入失败仍可读取旧数据。 */
export function readStorage(key: StorageKey): string | null {
  try {
    if (key === STORAGE_KEYS.app) return readLibrary();
    const legacyKey = LEGACY_KEYS[key];
    const current = localStorage.getItem(key);
    if (current !== null) {
      try { localStorage.removeItem(legacyKey); } catch { /* 下次启动重试清理 */ }
      return current;
    }
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      localStorage.setItem(key, legacy);
      if (localStorage.getItem(key) === legacy) localStorage.removeItem(legacyKey);
    } catch { /* 配额不足或禁止写入时保留旧数据，下次启动重试 */ }
    return legacy;
  } catch {
    return null;
  }
}
