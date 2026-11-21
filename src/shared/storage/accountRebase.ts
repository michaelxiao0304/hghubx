import { mergeFavoriteChanges } from "./libraryChanges";
import type { AccountData } from "../model/accountData";

// Aliases are created only after native boot confirms a retained session. Keep
// the original buckets on disk as snapshots, but never read them as live data
// again: switching back must not resurrect a removed favorite or cleared history.
export function accountKey(aliases: Record<string, string>, key: string): string {
  const seen = new Set<string>();
  while (typeof aliases[key] === "string" && !seen.has(key)) {
    seen.add(key);
    key = aliases[key];
  }
  return key;
}

export function mergeRebasedAccounts(source: AccountData, target?: AccountData): AccountData {
  if (!target) return source;
  const union = (a: number[], b: number[]) => [...new Set([...a, ...b])];
  const history = new Map(target.history.map(row => [row.id, row]));
  for (const row of source.history) {
    if (!history.has(row.id) || row.at >= history.get(row.id)!.at) history.set(row.id, row);
  }
  const dirtyHistory = { ...target.dirtyHistory };
  for (const [id, row] of Object.entries(source.dirtyHistory)) {
    if (!dirtyHistory[Number(id)] || row.at >= dirtyHistory[Number(id)].at) dirtyHistory[Number(id)] = row;
  }
  for (const id of Object.keys(dirtyHistory).map(Number)) {
    const latest = history.get(id);
    if (latest && latest.at > dirtyHistory[id].at) dirtyHistory[id] = { ep: latest.ep, at: latest.at };
  }
  const historyRemovedAt = { ...target.historyRemovedAt };
  for (const [id, at] of Object.entries(source.historyRemovedAt || {})) historyRemovedAt[+id] = Math.max(historyRemovedAt[+id] || 0, at);
  for (const [id, at] of Object.entries(historyRemovedAt)) {
    if ((history.get(+id)?.at ?? 0) <= at) history.delete(+id);
    if ((dirtyHistory[+id]?.at ?? 0) <= at) delete dirtyHistory[+id];
  }
  const favoriteChanges = mergeFavoriteChanges(source.favoriteChanges, target.favoriteChanges);
  const postFavoriteChanges = mergeFavoriteChanges(source.postFavoriteChanges, target.postFavoriteChanges);
  const favs = union(source.favs, target.favs).filter(id => favoriteChanges[id]?.on !== false);
  const favEpCounts = { ...target.favEpCounts };
  for (const [id, count] of Object.entries(source.favEpCounts || {})) {
    favEpCounts[Number(id)] = Math.max(favEpCounts[Number(id)] || 0, count);
  }
  for (const id of Object.keys(favEpCounts)) if (!favs.includes(+id)) delete favEpCounts[+id];
  const episodes = [...(source.likeEpisodes || []), ...(target.likeEpisodes || [])];
  return {
    ...source, favEpCounts, favoriteChanges, postFavoriteChanges, historyRemovedAt,
    favs, likes: union(source.likes, target.likes),
    follows: union(source.follows, target.follows), postFavs: union(source.postFavs, target.postFavs).filter(id => postFavoriteChanges[id]?.on !== false),
    postLikes: union(source.postLikes, target.postLikes),
    likeEpisodes: episodes.length ? [...new Map(episodes.map(row => [`${row.video_id}:${row.ep}`, row])).values()] : undefined,
    history: [...history.values()].sort((a, b) => b.at - a.at), dirtyHistory,
    // Preserve local seconds even if an older/empty remote history is returned.
    localHistory: [...history.keys()],
  };
}
