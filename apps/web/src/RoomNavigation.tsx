import { Hash, Headphones, HeadphoneOff, MessageSquare, MicOff, Plus } from 'lucide-react';
import type { CallParticipant, Room } from './api';
import './RoomNavigation.css';

export const roomLabel = (room: Room) => room.display_name || room.name;

export default function RoomNavigation({ rooms, selected, presence, known, onSelect, onCreate }: {
  rooms: Room[]; selected?: string; presence: Record<string, CallParticipant[]>; known: boolean;
  onSelect: (room: Room) => void; onCreate: () => void;
}) {
  return <div className="conversation-navigation">
    {(['channel', 'direct'] as const).map(kind => {
      const entries = rooms.filter(room => (room.kind ?? 'channel') === kind);
      if (kind === 'direct' && !entries.length) return null;
      return <section key={kind} aria-label={kind === 'direct' ? 'Direct messages' : 'Rooms'}>
        <div className="section-label">{kind === 'direct' ? 'DIRECT MESSAGES' : 'ROOMS'}
          {kind === 'channel' && <button aria-label="Create room" onClick={onCreate}><Plus size={16} /></button>}
        </div>
        {!entries.length && <p className="sidebar-hint">Create a room to bring your friends together.</p>}
        {entries.map(room => {
          const callers = presence[room.id] ?? [];
          return <div key={room.id} className="conversation-entry">
            <button className={'room-item ' + (selected === room.id ? 'active' : '')}
              aria-current={selected === room.id ? 'page' : undefined} onClick={() => onSelect(room)} title={roomLabel(room)}>
              {kind === 'direct' ? <MessageSquare size={18} /> : <Hash size={19} />}
              <span>{roomLabel(room)}</span>
              {known && callers.length > 0 && <span className="room-call-count" aria-label={`${callers.length} in call`}><Headphones size={12} />{callers.length}</span>}
            </button>
            {known && callers.length > 0 && <ul className="room-call-roster" aria-label={`${roomLabel(room)} call participants`}>
              {callers.map(person => <li key={person.user_id}>
                <span className="presence-avatar" aria-hidden="true">{(person.name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="presence-person-name">{person.name || 'Participant'}</span>
                {person.deafened ? <HeadphoneOff size={14} aria-label="Deafened" /> : person.muted ? <MicOff size={14} aria-label="Muted" /> : <span className="presence-live-dot" aria-label="In call" />}
              </li>)}
            </ul>}
          </div>;
        })}
      </section>;
    })}
    {!known && rooms.length > 0 && <p className="presence-unavailable">Call activity unavailable</p>}
  </div>;
}
