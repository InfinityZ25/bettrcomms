import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DesktopFrame from '@/features/shell/DesktopFrame';
import { ThemeProvider } from './components/theme-provider';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './styles.css';
import { startWailsFrontendRuntime } from '@/desktop/wailsFrontendRuntime';

// Before the first render: the Wails runtime is what reports this page's
// non-client regions to the host, and a title bar whose regions arrive after
// the first click is a title bar Windows does not hit-test.
startWailsFrontendRuntime();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="bettercomms-ui-theme">
      <TooltipProvider>
        <MotionConfig reducedMotion="user">
          <SidebarProvider className="h-dvh min-h-0! block!">
            <DesktopFrame>
              <App />
            </DesktopFrame>
          </SidebarProvider>
        </MotionConfig>
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
