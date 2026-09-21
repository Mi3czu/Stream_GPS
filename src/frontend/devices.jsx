import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';

const isOnline = (device) => device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 120_000;

const Devices = () => {
  const navigate = useNavigate();
  const [devices, setDevices] = useState([]);
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [search, setSearch] = useState('');
  const [issuedKey, setIssuedKey] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const headers = () => ({ Authorization: `Bearer ${sessionStorage.getItem('accessToken')}` });

  const loadDevices = async () => {
    try {
      const response = await axios.get('/api/v1/devices', { headers: headers() });
      setDevices(response.data.devices); setError(null);
    } catch (requestError) {
      if (requestError.response?.status === 401) {
        sessionStorage.removeItem('accessToken'); navigate('/login', { replace: true }); return;
      }
      setError(requestError.response?.data?.message || requestError.message);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!sessionStorage.getItem('accessToken')) navigate('/login', { replace: true });
    else loadDevices();
  }, [navigate]);

  const visibleDevices = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? devices.filter((device) => `${device.name} ${device.device_id} ${device.status}`.toLowerCase().includes(query)) : devices;
  }, [devices, search]);

  const createDevice = async (event) => {
    event.preventDefault(); setError(null); setIssuedKey(null);
    try {
      const response = await axios.post('/api/v1/devices', { name, ...(deviceId.trim() ? { device_id: deviceId.trim() } : {}) }, { headers: headers() });
      setIssuedKey({ deviceId: response.data.device.device_id, deviceKey: response.data.device_key });
      setName(''); setDeviceId(''); await loadDevices();
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const revokeDevice = async (id) => {
    if (!window.confirm(`Revoke ${id}? It will stop accepting GPS updates.`)) return;
    try { await axios.post(`/api/v1/devices/${encodeURIComponent(id)}/revoke`, {}, { headers: headers() }); await loadDevices(); }
    catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const replaceDeviceKey = async (id) => {
    if (!window.confirm(`Replace the GPS key for ${id}? The current GPS device configuration will stop sending updates until it uses the new key.`)) return;
    setError(null); setIssuedKey(null);
    try {
      const response = await axios.post(`/api/v1/devices/${encodeURIComponent(id)}/rotate-key`, {}, { headers: headers() });
      setIssuedKey({ deviceId: response.data.device.device_id, deviceKey: response.data.device_key }); await loadDevices();
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  return (
    <main>
      <header className="page-header"><div><h1>Devices</h1><p>Register GPS transmitters and manage their credentials.</p></div></header>
      {error && <div className="alert alert--error">{error}</div>}
      <section className="panel">
        <div className="panel__header"><h2>Add a GPS device</h2></div>
        <form onSubmit={createDevice}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Device name, e.g. Studio van" required />
          <input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="Optional ID, e.g. belabox_7522" />
          <button type="submit">Create device</button>
        </form>
      </section>
      {issuedKey && <section className="panel" style={{ borderColor: '#f79009' }}>
        <h2>Your device credentials</h2><p>Use this key to connect the GPS agent. You can reveal and copy it again later in this device's <strong>Your keys</strong> section. Never publish it or commit it to Git.</p>
        <p><strong>DEVICE_ID:</strong> <code>{issuedKey.deviceId}</code></p><p><strong>DEVICE_KEY:</strong> <code>{issuedKey.deviceKey}</code></p>
        <div className="sharing-actions"><Link className="button" to={`/devices/${encodeURIComponent(issuedKey.deviceId)}`}>Open device setup</Link><button type="button" className="button--secondary" onClick={() => setIssuedKey(null)}>Close</button></div>
      </section>}
      <section className="panel">
        <div className="panel__header"><h2>Registered devices</h2><span>{visibleDevices.length} of {devices.length}</span></div>
        <div className="toolbar"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, ID, or status" aria-label="Search devices" /></div>
        {loading ? <p>Loading devices...</p> : <div className="device-list">
          {visibleDevices.map((device) => (
            <article className="device-card" key={device.id}>
              <div className="device-card__top">
                <div><h2>{device.name}</h2><p className="device-card__id">{device.device_id}</p></div>
                <span className={`status-pill ${device.status !== 'active' ? 'status-pill--revoked' : isOnline(device) ? 'status-pill--online' : 'status-pill--offline'}`}>
                  {device.status !== 'active' ? device.status : isOnline(device) ? 'Online' : 'Offline'}
                </span>
              </div>
              <div className="device-card__metrics">
                <span className="metric">Last seen<strong>{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'Never'}</strong></span>
                <span className="metric">Speed<strong>{device.last_speed === null ? '—' : `${device.last_speed} km/h`}</strong></span>
                <span className="metric">Coordinates<strong>{device.last_latitude === null ? 'No GPS fix' : `${Number(device.last_latitude).toFixed(5)}, ${Number(device.last_longitude).toFixed(5)}`}</strong></span>
                <span className="metric">Satellites<strong>{device.last_satellites ?? '—'}</strong></span>
              </div>
              <div className="device-card__actions">
                <Link className="button button--small" to={`/devices/${encodeURIComponent(device.device_id)}`}>Open</Link>
                {device.status === 'active' && <button type="button" className="button--secondary button--small" onClick={() => replaceDeviceKey(device.device_id)}>Replace GPS key</button>}
                {device.status === 'active' && <button type="button" className="button--danger button--small" onClick={() => revokeDevice(device.device_id)}>Revoke</button>}
              </div>
            </article>
          ))}
          {!visibleDevices.length && <div className="empty-state">{search ? 'No devices match your search.' : 'No devices registered yet.'}</div>}
        </div>}
      </section>
    </main>
  );
};

export default Devices;
