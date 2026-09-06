import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from './components/ui/button';
import './WorkspaceScreen.css';

export default function WorkspaceScreen({
  title,
  description,
  onBack,
  children,
}: {
  title: 'Settings' | 'Recordings';
  description: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <main className="workspace-screen" aria-label={title}>
      <header className="workspace-screen__header">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={17} /> Back to call
        </Button>
        <nav aria-label="Workspace views">
          <a href="#/">Call</a>
          <a
            href="#/recordings"
            aria-current={title === 'Recordings' ? 'page' : undefined}
          >
            Recordings
          </a>
          <a
            href="#/settings"
            aria-current={title === 'Settings' ? 'page' : undefined}
          >
            Settings
          </a>
        </nav>
      </header>
      <div className="workspace-screen__scroll">
        <div className="workspace-screen__content">
          <div className="workspace-screen__intro">
            <span className="eyebrow">YOUR SPACE</span>
            <h1 tabIndex={-1} ref={heading}>
              {title}
            </h1>
            <p>{description}</p>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
