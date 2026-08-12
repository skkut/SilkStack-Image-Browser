import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import './styles/themes.css';
import { useImageStore } from './store/useImageStore';
import { useSettingsStore } from './store/useSettingsStore';
import ImageModalWindow from './components/ImageModalWindow';
import DevToolsShell from './components/DevToolsShell';

// Check if this window is an image viewer child window
const isImageViewer = new URLSearchParams(window.location.search).get('imageViewer') === 'true';

// Dev tools: opened via Ctrl+Y in the app (or ?devtools=<tool> directly);
// the shell hosts every tester behind a tab switcher.
const devtoolsParam = new URLSearchParams(window.location.search).get('devtools');

// Expose stores globally for debugging
if (process.env.NODE_ENV === 'development') {
  (window as any).useImageStore = useImageStore;
  (window as any).useSettingsStore = useSettingsStore;
  console.log('🔧 [DEV] Stores exposed globally: useImageStore, useSettingsStore');
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      {isImageViewer ? <ImageModalWindow /> :
       devtoolsParam ? <DevToolsShell initialTool={devtoolsParam} /> :
       <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
