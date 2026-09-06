import { useEffect, useRef, useState } from 'react';

export interface SpeakingActivityTrack {
  id: string;
  track: MediaStreamTrack;
}

type Meter = {
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  aboveSince: number | null;
  belowSince: number | null;
  speaking: boolean;
};

const ATTACK_MS = 50;
const RELEASE_MS = 200;
const EMIT_MS = 50;
const START_RMS = 0.035;
const STOP_RMS = 0.018;

export function useSpeakingActivity(
  tracks: SpeakingActivityTrack[],
  enabled: boolean,
): ReadonlySet<string> {
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(() => new Set());
  const context = useRef<AudioContext | undefined>(undefined);
  const meters = useRef(new Map<string, Meter>());
  const timer = useRef<number | undefined>(undefined);
  const lastEmit = useRef(0);
  const published = useRef(new Set<string>());

  const publish = (next: Set<string>, now: number, force = false) => {
    const previous = published.current;
    const changed =
      previous.size !== next.size || [...next].some((id) => !previous.has(id));
    if (!changed || (!force && now - lastEmit.current < EMIT_MS)) return;
    published.current = next;
    lastEmit.current = now;
    setSpeaking(next);
  };

  const stopMeter = (id: string) => {
    const meter = meters.current.get(id);
    if (!meter) return;
    meter.source.disconnect();
    meter.analyser.disconnect();
    meters.current.delete(id);
  };

  const shutdown = () => {
    if (timer.current !== undefined) window.clearInterval(timer.current);
    timer.current = undefined;
    for (const id of [...meters.current.keys()]) stopMeter(id);
    const activeContext = context.current;
    context.current = undefined;
    if (activeContext) void activeContext.close().catch(() => undefined);
    if (published.current.size) publish(new Set(), performance.now(), true);
  };

  const sample = () => {
    const now = performance.now();
    const next = new Set<string>();
    for (const [id, meter] of meters.current) {
      const unavailable =
        !meter.track.enabled || meter.track.muted || meter.track.readyState !== 'live';
      if (unavailable) {
        meter.speaking = false;
        meter.aboveSince = null;
        meter.belowSince = null;
        continue;
      }
      meter.analyser.getFloatTimeDomainData(meter.samples);
      let energy = 0;
      for (const value of meter.samples) energy += value * value;
      const rms = Math.sqrt(energy / meter.samples.length);
      if (!meter.speaking) {
        meter.belowSince = null;
        if (rms >= START_RMS) {
          meter.aboveSince ??= now;
          if (now - meter.aboveSince >= ATTACK_MS) meter.speaking = true;
        } else meter.aboveSince = null;
      } else {
        meter.aboveSince = null;
        if (rms <= STOP_RMS) {
          meter.belowSince ??= now;
          if (now - meter.belowSince >= RELEASE_MS) meter.speaking = false;
        } else meter.belowSince = null;
      }
      if (meter.speaking) next.add(id);
    }
    publish(next, now);
  };

  // Reconcile after every render. Array identity alone never tears down the graph.
  useEffect(() => {
    if (!enabled || typeof AudioContext === 'undefined') {
      shutdown();
      return;
    }
    let active = context.current;
    if (!active) {
      try {
        active = new AudioContext({ latencyHint: 'interactive' });
        context.current = active;
        void active.resume().catch(() => undefined);
      } catch {
        shutdown();
        return;
      }
    }
    const wanted = new Map(tracks.map((item) => [item.id, item.track]));
    for (const [id, meter] of meters.current)
      if (wanted.get(id) !== meter.track) stopMeter(id);
    for (const [id, track] of wanted) {
      if (meters.current.has(id) || track.kind !== 'audio') continue;
      try {
        const source = active.createMediaStreamSource(new MediaStream([track]));
        const analyser = active.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        meters.current.set(id, {
          track,
          source,
          analyser,
          samples: new Float32Array(analyser.fftSize),
          aboveSince: null,
          belowSince: null,
          speaking: false,
        });
      } catch {
        // A browser may reject an ended or unavailable device track.
      }
    }
    if (timer.current === undefined)
      timer.current = window.setInterval(sample, 25);
  });

  useEffect(() => shutdown, []);
  return speaking;
}
