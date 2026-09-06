import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DesktopFrame from './DesktopFrame';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopFrame>
      <App />
    </DesktopFrame>
  </React.StrictMode>,
);
