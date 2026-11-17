import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { WatchProgress } from "../../shared/model/store";
import type { VideoHandle } from "../playback/VideoSurface";

type Options = {
  id: number; scope: string; enabled: boolean; active: boolean;
  history: WatchProgress[];
  save: (id: number, ep?: number, time?: number, duration?: number) => void;
  initialId: number; startEp?: number; startTime?: number;
  video: RefObject<VideoHandle | null>;
};

/** Each visit captures its starting episode once. Observation and cleanup own
 * the writer from that account/clear generation, never a later video's writer. */
export function useWatchProgress({ id, scope, enabled, active, history, save, initialId, startEp, startTime, video }: Options) {
  const visit = JSON.stringify([scope, enabled, id]);
  const select = (initial = false) => {
    const saved = enabled ? history.find(row => row.id === id) : undefined;
    const explicit = initial && id === initialId && startEp !== undefined;
    const ep = explicit ? startEp : saved?.ep ?? 1;
    return { visit, ep, time: explicit ? startTime ?? 0 : saved?.t ?? 0 };
  };
  const [selection, setSelection] = useState(() => select(true));
  const current = selection.visit === visit ? selection : select();
  if (selection.visit !== visit) setSelection(current);
  const observation = useMemo(() => ({
    id, ep: current.ep, time: 0, duration: 0, observed: false, lastSaved: 0,
    resume: Math.max(0, current.time), seeking: false,
    save: enabled ? save : undefined,
  }), [visit, current.ep]);
  const latest = useRef(observation); latest.current = observation;
  const flush = (sample: typeof observation) => {
    if (sample.observed && sample.duration > 0 && sample.time > 0) {
      sample.save?.(sample.id, sample.ep, sample.time, sample.duration);
    }
  };
  useLayoutEffect(() => () => flush(observation), [observation]);
  useLayoutEffect(() => { if (!active) flush(observation); }, [active, observation]);

  return {
    episode: current.ep,
    pickEpisode: (ep: number) => {
      if (ep !== current.ep) setSelection({ visit, ep, time: 0 });
    },
    onTime: (time: number) => {
      if (!active || latest.current !== observation || !Number.isFinite(time)) return;
      // Clearing history invalidates the captured writer. Adopt the new one
      // only after a fresh observation, so an old cleanup cannot resurrect it.
      observation.save = enabled ? save : undefined;
      // A zero tick while metadata/seek is pending cannot overwrite a resume.
      if (observation.resume > 0) {
        if (!observation.seeking || Math.abs(time - observation.resume) > 1) return;
        observation.resume = 0;
      }
      observation.time = time; observation.observed = true;
      if (Date.now() - observation.lastSaved > 5000) {
        observation.lastSaved = Date.now(); flush(observation);
      }
    },
    onDuration: (duration: number) => {
      if (latest.current !== observation || !Number.isFinite(duration) || duration <= 0) return;
      observation.duration = duration;
      if (observation.resume > 0 && !observation.seeking && video.current) {
        observation.resume = Math.max(0, Math.min(observation.resume, duration - 0.15));
        video.current.seek(observation.resume, "history_resume");
        observation.seeking = true;
      }
    },
  };
}
