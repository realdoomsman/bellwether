// Global styles first: page stylesheets (imported by pages below) must override them.
// Self-hosted fonts: no third-party request, hashed + immutable-cached with the rest of the build.
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource/doto/800.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/domain.css';
import './styles/layout.css';
import { BRAND } from '@bellwether/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/Layout';
import { Mark } from './components/Logo';
import { ToastProvider } from './components/Toast';
import { connectStream } from './lib/stream';
import Landing from './pages/Landing';
import NotFound from './pages/NotFound';
import RouteError from './pages/RouteError';

function BootFallback() {
  return (
    <div className="boot" role="status">
      <Mark size={40} />
      <span className="sr-only">Loading {BRAND.name}…</span>
    </div>
  );
}

// Every page except the landing page is code-split: dynamic import() is what creates the lazy
// chunks (charts, wizard, docs) so the first paint only ships the landing bundle.
const router = createBrowserRouter([
  {
    element: <Layout />,
    // Shown only on a cold load of a code-split page while its chunk downloads.
    hydrateFallbackElement: <BootFallback />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Landing /> },
          { path: 'launch', lazy: async () => ({ Component: (await import('./pages/Launch')).default }) },
          { path: 'app', lazy: async () => ({ Component: (await import('./pages/Dashboard')).default }) },
          { path: 't/:address', lazy: async () => ({ Component: (await import('./pages/Token')).default }) },
          { path: 'leaderboard', lazy: async () => ({ Component: (await import('./pages/Leaderboard')).default }) },
          { path: 'proof', lazy: async () => ({ Component: (await import('./pages/Proof')).default }) },
          { path: 'docs', lazy: async () => ({ Component: (await import('./pages/Docs')).default }) },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

connectStream();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
