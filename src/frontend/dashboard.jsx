import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import GpsMap from './gps-map.jsx';

const isOnline = (device) => device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 120_000;
const formatLastSeen = (value) => value ? new Date(value).toLocaleString() : 'Never';

const Dashboard = () => {
  const navigate = useNavigate();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');
    if (!token) { navigate('/login', { replace: true }); return; }
    axios.get('/api/v1/devices', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setDevices(response.data.devices))
      .catch((requestError) => {
        if (requestError.response?.status === 401) {
          sessionStorage.removeItem('accessToken'); navigate('/login', { replace: true }); return;
        }
        setError(requestError.response?.data?.message || requestError.message);
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  const activeDevices = devices.filter((device) => device.status === 'active');
  const onlineDevices = activeDevices.filter(isOnline);
  const positionedDevices = activeDevices.filter((device) => device.last_latitude !== null).map((device) => ({
    latitude: device.last_latitude, longitude: device.last_longitude,
    recorded_at: device.last_recorded_at, speed: device.last_speed, name: device.name
  }));
  const latestDevices = [...devices].sort((a, b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0)).slice(0, 5);

  return (
    <main>
      <header className="page-header">
        <div><h1>Dashboard</h1><p>Overview of your GPS fleet and its latest activity.</p></div>
        <Link className="button" to="/devices">Add or manage devices</Link>
      </header>
      {error && <div className="alert alert--error">{error}</div>}
      <section className="stat-grid" aria-label="Device summary">
        <article className="stat-card"><span className="stat-card__label">All devices</span><span className="stat-card__value">{devices.length}</span></article>
        <article className="stat-card"><span className="stat-card__label">Online now</span><span className="stat-card__value">{onlineDevices.length}</span></article>
        <article className="stat-card"><span className="stat-card__label">Offline</span><span className="stat-card__value">{activeDevices.length - onlineDevices.length}</span></article>
        <article className="stat-card"><span className="stat-card__label">With GPS position</span><span className="stat-card__value">{positionedDevices.length}</span></article>
      </section>
      <section className="panel fleet-map">
        <div className="panel__header"><h2>Latest device positions</h2><span>{positionedDevices.length} visible</span></div>
        <GpsMap positions={positionedDevices} connectPoints={false} />
      </section>
      <section className="panel">
        <div className="panel__header"><h2>Recent devices</h2><Link to="/devices">View all</Link></div>
        {loading ? <p>Loading devices...</p> : <div className="device-list">
          {latestDevices.map((device) => (
            <article className="device-card" key={device.id}>
              <div className="device-card__top">
                <div><h2>{device.name}</h2><p className="device-card__id">{device.device_id}</p></div>
                <span className={`status-pill ${device.status !== 'active' ? 'status-pill--revoked' : isOnline(device) ? 'status-pill--online' : 'status-pill--offline'}`}>
                  {device.status !== 'active' ? device.status : isOnline(device) ? 'Online' : 'Offline'}
                </span>
              </div>
              <div className="device-card__metrics">
                <span className="metric">Last seen<strong>{formatLastSeen(device.last_seen_at)}</strong></span>
                <span className="metric">Speed<strong>{device.last_speed === null ? '—' : `${device.last_speed} km/h`}</strong></span>
                <span className="metric">GPS fix<strong>{device.last_latitude === null ? 'No position' : 'Available'}</strong></span>
                <span className="metric">Satellites<strong>{device.last_satellites ?? '—'}</strong></span>
              </div>
              <div className="device-card__actions"><Link className="button button--small" to={`/devices/${encodeURIComponent(device.device_id)}`}>Open device</Link></div>
            </article>
          ))}
          {!latestDevices.length && <div className="empty-state">No devices yet. Add your first GPS device to begin tracking.</div>}
        </div>}
      </section>
    </main>
  );
};

export default Dashboard;
