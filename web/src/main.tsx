import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
// configure() MUST run before any other endpoints-module import touches
// localStorage so existing user state under 'vulos.office.endpoints.v1'
// survives (do NOT change the key — that would wipe office users' cached
// endpoints). First-party module — see src/lib/endpoints/index.js.
import { configure } from './lib/endpoints/index.js'
configure({ lsKeyPrefix: 'vulos.office.endpoints.v1', healthPath: '/api/auth/status' })
// OFFICE-11: import/export fidelity round-trip checks (self-executes in dev mode).
// Loaded lazily so the `xlsx` import it pulls in stays OUT of the production
// graph entirely. Dev-only means production never pulls that weight.
if (import.meta.env.DEV) {
  import('./lib/roundTripCheck.js')
}
// OFFICE-OFFLINE-01: register the app-shell SW (+ prime cloud↔LAN failover +
// update detection) via the guarded PWA helper. No-op in dev, when embedded in
// the OS hub, or on unsupported browsers — see src/lib/pwa.js.
import { registerServiceWorker } from './lib/pwa.js'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)

registerServiceWorker()
