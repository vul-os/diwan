import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import LoginScreen from './components/LoginScreen'
import Layout from './components/Layout'
import { LoadingState } from './components/ui'
import Home from './components/Home'
import AppHome from './components/AppHome'
import DocsEditor from './apps/docs/DocsEditor'
import SheetsEditor from './apps/sheets/SheetsEditor'
import SlidesEditor from './apps/slides/SlidesEditor'
import WhiteboardEditor from './apps/whiteboard/WhiteboardEditor'
import PDFEditor from './apps/pdf/PDFEditor'
import SigningSetup from './apps/pdf/SigningSetup'
import Settings from './components/Settings'
import SignView from './apps/pdf/SignView'
import EnvelopeDashboard from './components/EnvelopeDashboard'
import Verify from './components/Verify'
import AnonDocView from './components/AnonDocView'
import InstallPrompt from './lib/InstallPrompt'

// Office is documents-only. Chat/video and calendar/contacts are THIRD-PARTY
// (not Vulos products) and are deliberately not launched or redirected to from
// here — Office ships no first-party Talk/Meet/Mail coupling.

// Public routes that bypass Vulos auth entirely.
// External signers and external verifiers have no Vulos account; anonymous
// share-link viewers ("/view/:token") are gated only by the unguessable token.
const PUBLIC_PREFIXES = ['/sign/', '/verify', '/view/']

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
}

export default function App() {
  const { status, loading, fetchStatus, fetchIdentity } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => { fetchStatus() }, [])
  // Resolve "who am I" for share/ownership UI (best-effort, independent of auth
  // gating). Re-runs when the authenticated status flips (e.g. after login).
  useEffect(() => {
    if (status?.authenticated !== false) fetchIdentity()
  }, [status?.authenticated])

  // ── Protocol handler + deep-link ?goto= param ─────────────────────────────
  useEffect(() => {
    // Register diwan:// protocol handler (web+ prefix required by browsers).
    // TS's lib.dom types only the current 2-arg spec signature; the trailing
    // title arg is a harmless legacy 3rd param some older engines still read
    // (extra JS call args are simply ignored where unsupported), so widen the
    // call's type locally rather than drop the argument.
    try {
      type RegisterProtocolHandlerLegacy = (scheme: string, url: string, title?: string) => void
      const registerProtocolHandlerLegacy = navigator.registerProtocolHandler as unknown as RegisterProtocolHandlerLegacy
      registerProtocolHandlerLegacy('web+diwan', window.location.origin + '/?goto=%s', 'Diwan')
    } catch { /* unsupported browser */ }

    // Handle incoming deep-link ?goto= param
    // e.g. OS rewrites web+diwan://docs/abc123 → https://app.vulos.org/?goto=docs%2Fabc123
    const params = new URLSearchParams(window.location.search)
    const goto = params.get('goto')
    if (goto) {
      const clean = goto.replace(/^\/+/, '')
      window.history.replaceState({}, '', window.location.pathname) // remove ?goto from URL
      if (clean) navigate('/' + clean, { replace: true })
    }
  }, []) // eslint-disable-line

  // Render public routes immediately — no auth check, no Layout shell.
  if (isPublicRoute(location.pathname)) {
    return (
      <Routes>
        <Route path="/sign/:token" element={<SignView />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/view/:token" element={<AnonDocView />} />
      </Routes>
    )
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg">
        <LoadingState label="Loading Diwan…" />
      </div>
    )
  }

  if (status?.enabled && !status?.authenticated) {
    return <LoginScreen />
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/docs" element={<AppHome type="doc" />} />
        <Route path="/sheets" element={<AppHome type="sheet" />} />
        <Route path="/slides" element={<AppHome type="slide" />} />
        <Route path="/whiteboards" element={<AppHome type="whiteboard" />} />
        <Route path="/docs/:id" element={<DocsEditor />} />
        <Route path="/sheets/:id" element={<SheetsEditor />} />
        <Route path="/slides/:id" element={<SlidesEditor />} />
        <Route path="/whiteboards/:id" element={<WhiteboardEditor />} />
        <Route path="/pdf" element={<AppHome type="pdf" />} />
        <Route path="/pdf-editor" element={<PDFEditor />} />
        <Route path="/signing-setup" element={<SigningSetup />} />
        <Route path="/envelopes" element={<EnvelopeDashboard />} />
        <Route path="/pdf/:id" element={<PDFEditor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <InstallPrompt />
    </Layout>
  )
}
