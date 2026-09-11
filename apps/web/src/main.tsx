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
