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
  const episodes = [...(source.likeEpisodes || []), ...(target.likeEpisodes || [])];
  return {
    ...source,
    favs: union(source.favs, target.favs), likes: union(source.likes, target.likes),
    follows: union(source.follows, target.follows), postFavs: union(source.postFavs, target.postFavs),
    postLikes: union(source.postLikes, target.postLikes),
    likeEpisodes: episodes.length ? [...new Map(episodes.map(row => [`${row.video_id}:${row.ep}`, row])).values()] : undefined,
    history: [...history.values()].sort((a, b) => b.at - a.at), dirtyHistory,
    // Preserve local seconds even if an older/empty remote history is returned.
    localHistory: union(union(source.localHistory, target.localHistory), [...history.keys()]),
  };
}
