/**
 * src/shells/OfficeShell.jsx — office.vulos.org standalone shell
 *
 * Canonical shell: reuses the SAME left-rail Layout/Sidebar as app.vulos.org
 * (brand lockup, ThemeSwitch, Home/Settings, light mode, real design tokens)
 * instead of the old divergent inline-styled top-nav with dead var fallbacks.
 * The only difference from <App> is the auth boundary: office.vulos.org gates
 * on <RequireAuth> (redirects to app.vulos.org/login on 401) rather than the
 * in-app LoginScreen.
 *
 * Routes mirror the app: each app section opens its file picker (AppHome) and
 * deep-links (/docs/:id …) open the editor. All four editor bundles are
 * code-split and loaded lazily.
 *
 * Deploy: dist-office/ SPA fallback — server must serve index.html for all
 * unmatched paths (see DEPLOY.md for the fly.toml snippet).
 */

import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import RequireAuth from './RequireAuth.jsx'
import Layout from '../components/Layout'
import Home from '../components/Home'
import AppHome from '../components/AppHome'
import Settings from '../components/Settings'
import AnonDocView from '../components/AnonDocView.jsx'
import InstallPrompt from '../lib/InstallPrompt.jsx'
import { LoadingState } from '../components/ui'

const DocsEditor   = lazy(() => import('../apps/docs/DocsEditor.jsx'))
const SheetsEditor = lazy(() => import('../apps/sheets/SheetsEditor.jsx'))
const SlidesEditor = lazy(() => import('../apps/slides/SlidesEditor.jsx'))
const PDFEditor    = lazy(() => import('../apps/pdf/PDFEditor.jsx'))

function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center bg-bg">
      <LoadingState label="Loading…" />
    </div>
  )
}

export default function OfficeShell() {
  const location = useLocation()

  // Anonymous read-only share-link view bypasses auth entirely (the unguessable
  // token is the credential) — it must render OUTSIDE <RequireAuth>/<Layout>.
  if (location.pathname.startsWith('/view/')) {
    return (
      <Routes>
        <Route path="/view/:token" element={<AnonDocView />} />
      </Routes>
    )
  }

  return (
    <RequireAuth>
      <Layout>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/docs" element={<AppHome type="doc" />} />
            <Route path="/sheets" element={<AppHome type="sheet" />} />
            <Route path="/slides" element={<AppHome type="slide" />} />
            <Route path="/pdf" element={<AppHome type="pdf" />} />
            <Route path="/docs/:id" element={<DocsEditor />} />
            <Route path="/sheets/:id" element={<SheetsEditor />} />
            <Route path="/slides/:id" element={<SlidesEditor />} />
            <Route path="/pdf/:id" element={<PDFEditor />} />
            <Route path="/pdf-editor" element={<PDFEditor />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <InstallPrompt />
      </Layout>
    </RequireAuth>
  )
}
