import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initSentry } from './config/sentry';
import {
  installChunkErrorAutoReload,
  clearChunkReloadGuard,
} from './utils/lazyWithRetry';
import './api/client';
// Canonical design-token layer (P0.2) — declared FIRST so every stylesheet +
// primitive can read `var(--teal)` etc. This is the single source (generated
// from src/styles/tokens.ts). index.css consumes it at the app root.
import './styles/tokens.css';
import './index.css';

// Initialize Sentry for error reporting and performance monitoring
initSentry();

// Self-heal stale code-split chunks after a redeploy:
// install a global ChunkLoadError net, and clear the one-time reload guard now
// that the app bundle loaded successfully (so a future redeploy can self-heal again).
installChunkErrorAutoReload();
clearChunkReloadGuard();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <App />
);
