import { Link, Route, Routes } from 'react-router-dom';
import Login from './login.jsx';
import Register from './register.jsx';
import Dashboard from './dashboard';
import Devices from './devices.jsx';
import DeviceDetails from './device-details.jsx';
import ObsOverlay from './obs-overlay.jsx';
import OverlaySettings from './overlay-settings.jsx';
import AuditLog from './audit-log.jsx';
import AccountSettings from './account-settings.jsx';
import AppShell from './app-shell.jsx';
import ThemeToggle from './theme-toggle.jsx';
import PublicMap from './public-map.jsx';

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
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
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
    </Routes>
  );
}
