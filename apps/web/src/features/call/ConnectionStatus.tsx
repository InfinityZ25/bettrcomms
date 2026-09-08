import { useEffect, useRef, useState } from 'react';
import { Activity, Signal, X } from 'lucide-react';
import type { PeerMediaStats } from '@/media';
import './ConnectionStatus.css';

export default function ConnectionStatus({
  joined,
  peerCount,
  serverRtt,
  stats,
  names,
  onDetails,
}: {
  joined: boolean;
  peerCount: number;
  serverRtt: number | null;
  stats: PeerMediaStats[];
  names: Record<string, string>;
  onDetails(): void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<{ source: string; values: number[] }>({
    source: '',
    values: [],
  });
  const [position, setPosition] = useState({ left: 8, bottom: 80 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const relayed = stats.some(s => s.voiceRelay?.state === 'relayed');
  const callValues = stats
    .filter((s) => s.connectionState === 'connected')
    .map((s) => s.route?.currentRoundTripTimeMs)
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0,
    );
  const source = relayed ? 'Server' : peerCount ? 'Call' : 'Server';
  const value = !joined
    ? null
    : relayed ? serverRtt : peerCount
      ? callValues.length
        ? Math.max(...callValues)
        : null
      : serverRtt;
  const quality =
    value === null
      ? 'pending'
      : value < 100
        ? 'good'
        : value < 250
          ? 'fair'
          : 'poor';
  useEffect(() => {
    if (!joined) {
      setOpen(false);
      setHistory({ source: '', values: [] });
      return;
    }
    setHistory((previous) => ({
      source,
      values:
        value === null
          ? previous.source === source
            ? previous.values
            : []
          : [
              ...(previous.source === source ? previous.values : []),
              value,
            ].slice(-30),
    }));
  }, [joined, stats, serverRtt, source]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(
            8,
            Math.min(
              rect.left,
              window.innerWidth - Math.min(320, window.innerWidth - 16) - 8,
            ),
          ),
          bottom: Math.max(
            8,
            Math.min(
              window.innerHeight - rect.top + 10,
              window.innerHeight - 280,
            ),
          ),
        });
    };
    place();
    const close = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        button.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  const values = history.source === source ? history.values : [];
  const ceiling = Math.max(50, ...values);
  const points = values
    .map(
      (n, i) =>
        `${values.length === 1 ? 0 : (i * 280) / (values.length - 1)},${60 - Math.min(1, n / ceiling) * 50}`,
    )
    .join(' ');
  const ms = (n: number | null | undefined) =>
    n === null || n === undefined ? '—' : `${Math.round(n)} ms`;
  return (
    <div className="connection-status">
      <button
        ref={button}
        className={`connection-trigger connection-${quality}`}
        aria-label="Connection diagnostics"
        aria-expanded={open}
        aria-controls={open ? 'call-connection-details' : undefined}
        title={
          joined
            ? `${source} ping: ${ms(value)}`
            : 'Join a call to measure connection latency'
        }
        onClick={() => setOpen(!open)}
      >
        <Signal size={21} />
        <span>
          <strong>
            {joined
              ? peerCount
                ? relayed ? 'Voice via server' : stats.some((s) => s.connectionState === 'connected')
                  ? 'Voice connected'
                  : 'Connecting…'
                : 'Waiting for your people'
              : 'Not connected'}
          </strong>
          <small>
            {joined
              ? `${source} · ${value === null ? 'Measuring…' : ms(value)}`
              : 'Join a call to see ping'}
          </small>
        </span>
      </button>
      {open && (
        <div
          ref={panel}
          id="call-connection-details"
          className="connection-popover"
          role="region"
          aria-label="Connection details"
          style={{
            ...position,
            maxHeight: `calc(100dvh - ${position.bottom + 8}px)`,
          }}
        >
          <header>
            <strong>Connection</strong>
            <button
              aria-label="Close connection details"
              onClick={() => {
                setOpen(false);
                button.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          </header>
          <div className={`connection-reading connection-${quality}`}>
            <Signal size={23} />
            <strong>{ms(value)}</strong>
            <span>{source.toLowerCase()} ping</span>
          </div>
          <svg
            viewBox="0 0 280 70"
            role="img"
            aria-label={`Recent ${source.toLowerCase()} ping history`}
          >
            <path d="M0 60H280 M0 10H280" className="connection-grid" />
            {values.length > 1 && <polyline points={points} />}
          </svg>
          <dl>
            <div>
              <dt>Average ({source.toLowerCase()})</dt>
              <dd>
                {ms(
                  values.length
                    ? values.reduce((a, b) => a + b, 0) / values.length
                    : null,
                )}
              </dd>
            </div>
            <div>
              <dt>Signaling server</dt>
              <dd>{joined ? ms(serverRtt) : '—'}</dd>
            </div>
          </dl>
          {stats.map((s) => (
            <div className="connection-peer" key={s.peerId}>
              <span>
                {names[s.peerId] ?? 'Friend'}
                <small>
                  {s.voiceRelay?.state === 'relayed' ? 'Encrypted server voice · TCP' : s.voiceRelay?.state === 'connecting' ? 'Connecting server voice…' : s.voiceRelay?.state === 'unavailable' && s.connectionState !== 'connected' ? s.voiceRelay.message ?? 'Server voice unavailable' : s.connectionState === 'connected'
                    ? s.route?.localCandidateType === 'relay' ||
                      s.route?.remoteCandidateType === 'relay'
                      ? 'Relay'
                      : s.route?.localCandidateType
                        ? 'Direct'
                        : 'Measuring route'
                    : s.connectionState}
                </small>
              </span>
              <strong>
                {s.voiceRelay?.state === 'relayed' ? 'Server route' : s.connectionState === 'connected'
                  ? ms(s.route?.currentRoundTripTimeMs)
                  : '—'}
              </strong>
            </div>
          ))}
          {stats.filter(s => s.voiceRelay?.verificationCode).map(s => (
            <details key={`key-${s.peerId}`}>
              <summary>Verify voice with {names[s.peerId] ?? 'Friend'}</summary>
              <p>Compare this code through another trusted channel. Matching codes verify the encryption keys for this relay session. Reconnecting changes the code.</p>
              <code style={{ overflowWrap: 'anywhere' }}>{s.voiceRelay!.verificationCode}</code>
            </details>
          ))}
          <p>
            {!joined
              ? 'Join a call to start measuring.'
              : peerCount
                ? relayed ? 'Server ping measures signaling, not the full relayed audio path. Server voice can pause while TCP recovers lost packets. Video still uses WebRTC.' : 'Call ping is the highest measured round-trip time to a connected friend. Voice travels directly or through TURN.'
                : 'Server ping measures chat and signaling. Call ping appears when a friend connects.'}
          </p>
          <button
            className="connection-more"
            onClick={() => {
              setOpen(false);
              onDetails();
            }}
          >
            <Activity size={14} />
            Advanced diagnostics
          </button>
        </div>
      )}
    </div>
  );
}
