// The favorites API has no modification times. Remember which origin confirmed
// a removal, so an older mirror cannot undo it. A subsequent add at that origin
// (or an explicit local add) is a new decision.
export type FavoriteChange = { at: number; on: boolean; origin: string; observed?: boolean };
export type FavoriteChanges = Record<number, FavoriteChange>;

export function favoriteChanges(raw?: FavoriteChanges): FavoriteChanges {
  return Object.fromEntries(Object.entries(raw || {}).filter(([id, change]) =>
    Number.isSafeInteger(+id) && +id > 0 && change && Number.isFinite(change.at)
    && typeof change.on === "boolean" && typeof change.origin === "string"));
}

export function mergeFavoriteChanges(first?: FavoriteChanges, second?: FavoriteChanges): FavoriteChanges {
  const result = { ...second };
  for (const [id, change] of Object.entries(first || {})) {
    if (!result[+id] || result[+id].at <= change.at) result[+id] = change;
  }
  return result;
}

export function syncedFavorites(remote: number[], changes: FavoriteChanges | undefined, origin: string) {
  const next = { ...changes };
  const present = new Set(remote);
  for (const [key, change] of Object.entries(next)) {
    const id = Number(key);
    const listed = present.has(id);
    if (change.origin === origin) {
      if (listed === change.on) next[id] = { ...change, observed: true };
      else if (change.observed) {
        // The writing server echoed our operation before this later change.
        next[id] = { at: Date.now(), on: listed, origin, observed: true };
        continue;
      }
    }
    if (change.on) present.add(id);
    else present.delete(id);
  }
  return { ids: [...present], changes: next };
}

export function historyRemovals(raw?: Record<number, number>): Record<number, number> {
  return Object.fromEntries(Object.entries(raw || {}).filter(([id, at]) =>
    Number.isSafeInteger(+id) && +id > 0 && Number.isFinite(at) && at > 0));
}
