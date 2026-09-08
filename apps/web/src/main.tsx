import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DesktopFrame from './DesktopFrame';
import { ThemeProvider } from './components/theme-provider';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="bettercomms-ui-theme">
      <DesktopFrame>
        <App />
      </DesktopFrame>
    </ThemeProvider>
  </React.StrictMode>,
);
