import { lazy, Suspense } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import Login from './login.jsx';
import Register from './register.jsx';
import AppShell from './app-shell.jsx';
import ThemeToggle from './theme-toggle.jsx';

const Dashboard = lazy(() => import('./dashboard.jsx'));
const Devices = lazy(() => import('./devices.jsx'));
const DeviceDetails = lazy(() => import('./device-details.jsx'));
const ObsOverlay = lazy(() => import('./obs-overlay.jsx'));
const OverlaySettings = lazy(() => import('./overlay-settings.jsx'));
const AuditLog = lazy(() => import('./audit-log.jsx'));
const AccountSettings = lazy(() => import('./account-settings.jsx'));
const PublicMap = lazy(() => import('./public-map.jsx'));
const ResetPassword = lazy(() => import('./reset-password.jsx'));
const RequestPasswordReset = lazy(() => import('./reset-password.jsx').then((module) => ({ default: module.RequestPasswordReset })));

function Home() {
  return (
    <main className="auth-page">
      <ThemeToggle compact />
      <div className="auth-card">
      <h1>Stream GPS</h1>

      <p>
        <Link to="/login">Login</Link>
      </p>

      <p>
        <Link to="/register">Register</Link>
      </p>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <Suspense fallback={<main className="route-loading">Loading…</main>}><Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<RequestPasswordReset />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/overlay/:overlayId" element={<ObsOverlay />} />
      <Route path="/map/:shareId" element={<PublicMap />} />
      <Route element={<AppShell />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/devices/:deviceId" element={<DeviceDetails />} />
        <Route path="/devices/:deviceId/overlays/:overlayId" element={<OverlaySettings />} />
        <Route path="/audit-log" element={<AuditLog />} />
        <Route path="/account" element={<AccountSettings />} />
      </Route>
    </Routes></Suspense>
  );
}
