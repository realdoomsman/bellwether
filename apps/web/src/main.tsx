// Global styles first: page stylesheets (imported by pages below) must override them.
// Self-hosted fonts: no third-party request, hashed + immutable-cached with the rest of the build.
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/signature.css';
import './styles/domain.css';
import { BRAND, marketSession } from '@bellwether/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/Layout';
import { Monogram } from './components/Logo';
import { ToastProvider } from './components/Toast';
import { api } from './lib/api';
import { connectStream } from './lib/stream';
import { prefetch } from './lib/useApi';
import Landing from './pages/Landing';
import NotFound from './pages/NotFound';
import RouteError from './pages/RouteError';

function BootFallback() {
  return (
    <div className="boot" role="status">
      <Monogram size={40} />
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
          // Design-system reference for page work: every component in every state. Not linked, noindex.
          { path: '_kit', lazy: async () => ({ Component: (await import('./pages/Kit')).default }) },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

// The hero sky tint follows the US session; set it before the first paint (Layout keeps it current).
document.documentElement.dataset.session = marketSession();
connectStream();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

// Paper mode puts a disclosure line above the header; painting before the engine's status is known
// would push the whole page down when it arrives. So the first render waits for it: index.html
// preloads it alongside this bundle, so it's normally already here. Capped, so a slow or unreachable
// engine never holds the page back (it then gets the "Engine unreachable" line instead). Not a
// top-level await: that would stop the bundler from letting route chunks share this entry chunk.
void Promise.race([prefetch('status', api.status), new Promise((resolve) => setTimeout(resolve, 800))]).then(() =>
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </StrictMode>,
  ),
);
