import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Blobatar } from '@blobatar/react';
import * as expressions from 'blobatar/expression';
import 'blobatar/gaze.css';
import type { CharacterAppearance, User } from '@/api';
import { blobatarFor } from '@/features/settings/blobatarIdentity';
import { characterSeed, ORIGINAL_CHARACTER } from '@/features/settings/character';
import { characterSnapshot, subscribeCharacter } from '@/features/settings/characterStore';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Expression } from './brain';
import { faceGeometry, mouthPaths, type Box, type FaceGeometry } from './faceGeometry';
import { PetEngine, type Visit, type VisitorElements } from './PetEngine';
import { personalityFor } from './personality';
import { PET_SIZE_PX, usePetSettings } from './petSettings';
import './pet.css';

const POSES: Record<Expression, expressions.Expression | undefined> = {
  idle: undefined,
  happy: expressions.happy,
  sad: expressions.sad,
  mad: expressions.mad,
  surprised: expressions.surprised,
  wink: expressions.wink,
  sleepy: expressions.sleepy,
  smug: expressions.smug,
  unsure: expressions.unsure,
  scared: expressions.scared,
  love: expressions.love,
  shy: expressions.shy,
  sick: expressions.sick,
  thinking: expressions.thinking,
};

/** One entrance per page load; changing size or character later should not replay it. */
let entered = false;

const DEFAULT_GEOMETRY = faceGeometry({ x: 18, y: 20, width: 64, height: 60 }, []);

type Measured = { geometry: FaceGeometry; ink: string };
const DEFAULT_MEASURED: Measured = { geometry: DEFAULT_GEOMETRY, ink: '' };

/** Reads the rendered silhouette once: where the body and eyes are, and the eyes' colour for the mouth. */
function measure(svg: SVGSVGElement | null): Measured | undefined {
  if (!svg) return undefined;
  try {
    const head = svg.querySelector<SVGGraphicsElement>('.mo-bob > g:not(.mo-eyes)');
    const eyes = [...svg.querySelectorAll<SVGGraphicsElement>('.mo-eye')];
    if (!head) return undefined;
    const box = (element: SVGGraphicsElement): Box => {
      const { x, y, width, height } = element.getBBox();
      return { x, y, width, height };
    };
    return { geometry: faceGeometry(box(head), eyes.map(box)), ink: svg.style.getPropertyValue('--mo-eye').trim() };
  } catch {
    return undefined;
  }
}

/** Mouth, cheeks and the hit area, laid over the drawing in its own viewBox. */
function FaceOverlay({ geometry }: { geometry: FaceGeometry }) {
  const paths = mouthPaths(geometry.mouth);
  const { x, y, width } = geometry.mouth;
  return (
    <svg className="pet-overlay" viewBox="0 0 100 100" aria-hidden="true">
      {geometry.cheeks.map((cheek, index) => (
        <ellipse key={index} className="pet-cheek" cx={cheek.x} cy={cheek.y} rx={cheek.rx} ry={cheek.ry} />
      ))}
      <g className="pet-mouth">
        <path data-mouth="smile" d={paths.smile} />
        <path data-mouth="cat" d={paths.cat} />
        <path data-mouth="flat" d={paths.flat} />
        <path data-mouth="wavy" d={paths.wavy} />
        <path data-mouth="open" className="pet-mouth-fill" d={paths.open} />
        <ellipse data-mouth="o" className="pet-mouth-fill" cx={x} cy={y + width * 0.32} rx={width * 0.26} ry={width * 0.34} />
        <ellipse data-mouth="talk" className="pet-mouth-fill" cx={x} cy={y + width * 0.26} rx={width * 0.32} ry={width * 0.3} />
      </g>
    </svg>
  );
}

function faceStyle({ geometry, ink }: Measured): CSSProperties {
  const { body, feet, span } = geometry;
  return {
    ...(ink ? { '--pet-ink': ink } : {}),
    '--pet-feet-x': `${feet.dx}%`,
    '--pet-feet-y': `${feet.dy}%`,
    '--pet-span': span,
    '--pet-head': `${body.y + feet.dy}%`,
    '--pet-hit-x': `${body.x}%`,
    '--pet-hit-y': `${body.y}%`,
    '--pet-hit-w': `${body.width}%`,
    '--pet-hit-h': `${body.height}%`,
  } as CSSProperties;
}

function Visitor({ visit, size, onElements }: { visit: Visit; size: number; onElements: (elements: VisitorElements | null) => void }) {
  const face = blobatarFor(visit.userId, visit.character);
  const svg = useRef<SVGSVGElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const fx = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<Measured>(DEFAULT_MEASURED);
  const root = useCallback((node: HTMLDivElement | null) => {
    if (!node || !body.current || !fx.current) {
      onElements(null);
      return;
    }
    const next = measure(svg.current);
    if (next) setMeasured(next);
    onElements({ root: node, body: body.current, fx: fx.current, svg: () => svg.current });
  }, [onElements]);
  return (
    <div ref={root} className="pet pet-visitor" style={{ '--pet-size': `${size}px` } as CSSProperties} aria-hidden="true" data-mouth="smile" data-expr="happy">
      <div className="pet-shadow" />
      <div className="pet-hop">
        <div ref={body} className="pet-body">
          <div className="pet-face" style={faceStyle(measured)}>
            <Blobatar ref={svg} name={face.name} hue={face.hue} animate="always" expression={expressions.happy} />
            <FaceOverlay geometry={measured.geometry} />
          </div>
          <div ref={fx} className="pet-fx" style={faceStyle(measured)} />
        </div>
      </div>
    </div>
  );
}

/**
 * Your character, living on the screen.
 *
 * React renders the creature and its wrappers once per character and size;
 * `PetEngine` moves them from there. The only state here is the expression,
 * which is what the generator needs a re-render for, and the friend visiting.
 */
export default function Pet({ user }: { user: User }) {
  const settings = usePetSettings();
  const subscribe = useCallback((listener: () => void) => subscribeCharacter(user.id, listener), [user.id]);
  const snapshot = useCallback(() => characterSnapshot(user.id), [user.id]);
  const stored = useSyncExternalStore(subscribe, snapshot, snapshot);
  const character: CharacterAppearance = stored ?? user.character ?? ORIGINAL_CHARACTER;
  const face = blobatarFor(user.id, character);
  const seed = characterSeed(user.id, character.variant);
  const personality = useMemo(() => personalityFor(seed), [seed]);
  // A phone's composer is a thumb's width from the messages; the creature shrinks to match.
  const phone = useIsMobile();
  const size = Math.round(PET_SIZE_PX[settings.size] * (phone ? 0.75 : 1));
  const [expression, setExpression] = useState<Expression>('idle');
  const [visit, setVisit] = useState<Visit | null>(null);
  const [measured, setMeasured] = useState<Measured>(DEFAULT_MEASURED);
  const engine = useRef<PetEngine | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const parts = useRef<{ hop?: HTMLDivElement | null; body?: HTMLDivElement | null; hit?: HTMLDivElement | null; shadow?: HTMLDivElement | null; fx?: HTMLDivElement | null }>({});
  const root = useRef<HTMLDivElement | null>(null);

  // The silhouette is measured once per character so the feet, mouth and
  // cheeks sit where this particular creature has them.
  useLayoutEffect(() => {
    const next = measure(svg.current);
    if (next) setMeasured(next);
  }, [face.name, face.hue]);

  useLayoutEffect(() => {
    const { hop, body, hit, shadow, fx } = parts.current;
    if (!root.current || !hop || !body || !hit || !shadow || !fx) return;
    const current = new PetEngine(
      { root: root.current, hop, body, hit, shadow, fx, svg: () => svg.current },
      personality,
      size,
      { setExpression, setVisit },
      user.id,
    );
    engine.current = current;
    current.start(!entered);
    // Consumed only by an engine that survives its first tick, so Strict Mode's
    // rehearsal mount does not use up the one entrance.
    const consumed = setTimeout(() => { entered = true; }, 0);
    return () => {
      clearTimeout(consumed);
      current.stop();
      if (engine.current === current) engine.current = null;
      setVisit(null);
      setExpression('idle');
    };
  }, [personality, size, user.id]);

  const onVisitor = useCallback((elements: VisitorElements | null) => engine.current?.setVisitorElements(elements), []);

  return (
    <>
      <div
        ref={root}
        className="pet"
        style={{ '--pet-size': `${size}px` } as CSSProperties}
        aria-hidden="true"
        data-companion-user={user.id}
        data-character-seed={face.name}
        data-character-hue={face.hue}
        data-pet-traits={personality.traits.join(' ')}
        data-pet-signature={personality.signature}
      >
        <div ref={(node) => { parts.current.shadow = node; }} className="pet-shadow" style={faceStyle(measured)} />
        <div ref={(node) => { parts.current.hop = node; }} className="pet-hop">
          <div ref={(node) => { parts.current.body = node; }} className="pet-body">
            <div className="pet-face" style={faceStyle(measured)}>
              <Blobatar ref={svg} name={face.name} hue={face.hue} animate="always" expression={POSES[expression]} />
              <FaceOverlay geometry={measured.geometry} />
              <div ref={(node) => { parts.current.hit = node; }} className="pet-hit" />
            </div>
            {/* Inside the body, so a mark stays over the head while it jumps. */}
            <div ref={(node) => { parts.current.fx = node; }} className="pet-fx" style={faceStyle(measured)} />
          </div>
        </div>
      </div>
      {visit && <Visitor key={visit.id} visit={visit} size={Math.round(size * 0.86)} onElements={onVisitor} />}
    </>
  );
}
