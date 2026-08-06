import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './state';
import './styles.css';
import { initTheme } from './theme';

// Applied before the first paint so the page never flashes the wrong theme.
initTheme();

/**
 * The aurora and grain sit behind everything, outside the router, so they are
 * never torn down and re-created on navigation — the drift stays continuous as
 * you move around the app.
 */
function Backdrop() {
  return (
    <>
      <div className="aurora" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="grain" aria-hidden="true" />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Backdrop />
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
