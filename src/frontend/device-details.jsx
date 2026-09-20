import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate, useParams } from 'react-router-dom';
import GpsMap from './gps-map.jsx';

const distanceMeters = (a, b) => {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(Number(b.latitude) - Number(a.latitude));
  const dLon = rad(Number(b.longitude) - Number(a.longitude));
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(Number(a.latitude))) * Math.cos(rad(Number(b.latitude))) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const DeviceDetails = () => {
  const { deviceId } = useParams();
  const navigate = useNavigate();
  const [device, setDevice] = useState(null);
  const [positions, setPositions] = useState([]);
  const [rangeHours, setRangeHours] = useState('24');
  const [liveStatus, setLiveStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [overlayResult, setOverlayResult] = useState(null);
  const [overlays, setOverlays] = useState([]);
  const token = sessionStorage.getItem('accessToken');
  const headers = { Authorization: `Bearer ${token}` };

  const loadDevice = useCallback(async () => {
    if (!token) { navigate('/login', { replace: true }); return; }
    const params = new URLSearchParams({ limit: '5000' });
    if (rangeHours !== 'all') params.set('from', new Date(Date.now() - Number(rangeHours) * 3600000).toISOString());
    try {
      const [deviceResponse, historyResponse, overlaysResponse] = await Promise.all([
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}`, { headers }),
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/history?${params}`, { headers }),
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/overlays`, { headers })
      ]);
      setDevice(deviceResponse.data.device); setPositions(historyResponse.data.positions); setOverlays(overlaysResponse.data.overlays); setError(null);
    } catch (requestError) {
      if (requestError.response?.status === 401) { sessionStorage.removeItem('accessToken'); navigate('/login', { replace: true }); return; }
      setError(requestError.response?.data?.message || requestError.message);
    } finally { setLoading(false); }
  }, [deviceId, navigate, rangeHours, token]);

  useEffect(() => { loadDevice(); }, [loadDevice]);

  useEffect(() => {
    if (!token) return undefined;
    let source; let renewal; let cancelled = false;
    const connect = async () => {
      try {
        setLiveStatus('connecting');
        const response = await axios.post(`/api/v1/devices/${encodeURIComponent(deviceId)}/live-token`, {}, { headers });
        if (cancelled) return;
        source = new EventSource(`/api/v1/devices/${encodeURIComponent(deviceId)}/live?token=${encodeURIComponent(response.data.token)}`);
        source.addEventListener('ready', () => setLiveStatus('live'));
        source.addEventListener('position', (event) => {
          const payload = JSON.parse(event.data).device;
          setLiveStatus('live');
          setDevice((current) => current ? { ...current, last_seen_at: payload.last_seen_at, last_latitude: payload.latitude,
            last_longitude: payload.longitude, last_speed: payload.speed, last_heading: payload.heading,
            last_altitude: payload.altitude, last_accuracy: payload.accuracy, last_satellites: payload.satellites,
            last_recorded_at: payload.recorded_at } : current);
          const next = { latitude: payload.latitude, longitude: payload.longitude, speed: payload.speed, heading: payload.heading,
            altitude: payload.altitude, accuracy: payload.accuracy, satellites: payload.satellites, recorded_at: payload.recorded_at };
          setPositions((current) => [...current.filter((item) => item.recorded_at !== next.recorded_at), next].slice(-5000));
        });
        source.onerror = () => setLiveStatus('reconnecting');
        renewal = window.setTimeout(() => { source?.close(); connect(); }, 240000);
      } catch { setLiveStatus('unavailable'); }
    };
    connect();
    return () => { cancelled = true; source?.close(); window.clearTimeout(renewal); };
  }, [deviceId, token]);

  const stats = useMemo(() => {
    const speeds = positions.map((p) => Number(p.speed)).filter(Number.isFinite);
    const distance = positions.slice(1).reduce((sum, point, index) => sum + distanceMeters(positions[index], point), 0);
    return { distance, maxSpeed: speeds.length ? Math.max(...speeds) : null, avgSpeed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null };
  }, [positions]);

  const createOverlay = async () => {
    try {
      const response = await axios.post(`/api/v1/devices/${encodeURIComponent(deviceId)}/overlays`, { name: `${device?.name || deviceId} OBS` }, { headers });
      setOverlayResult(response.data); setOverlays((current) => [response.data.overlay, ...current]);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const revokeOverlay = async (overlayId) => {
    if (!window.confirm('Revoke this OBS overlay? Its URL will stop working immediately.')) return;
    try { await axios.post(`/api/v1/overlays/${encodeURIComponent(overlayId)}/revoke`, {}, { headers }); setOverlays((current) => current.map((o) => o.id === overlayId ? { ...o, status: 'revoked' } : o)); }
    catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const exportHistory = async (format) => {
    try {
      const params = new URLSearchParams({ format });
      if (rangeHours !== 'all') params.set('from', new Date(Date.now() - Number(rangeHours) * 3600000).toISOString());
      const response = await axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/history/export?${params}`, { headers, responseType: 'blob' });
      const url = URL.createObjectURL(response.data); const link = document.createElement('a');
      link.href = url; link.download = `${deviceId}-history.${format}`; link.click(); URL.revokeObjectURL(url);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const deleteHistory = async () => {
    if (!window.confirm(`Permanently delete all GPS history for ${deviceId}? This cannot be undone.`)) return;
    try { await axios.delete(`/api/v1/devices/${encodeURIComponent(deviceId)}/history`, { headers }); setPositions([]); await loadDevice(); }
    catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const deleteDevice = async () => {
    const confirmation = window.prompt(`Permanent deletion removes the device, history and overlays. Type ${deviceId} to confirm:`);
    if (confirmation !== deviceId) return;
    try { await axios.delete(`/api/v1/devices/${encodeURIComponent(deviceId)}`, { headers, data: { confirm_device_id: confirmation } }); navigate('/devices'); }
    catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  if (loading && !device) return <main><p>Loading device...</p></main>;
  return <main>
    <header className="page-header"><div><p><Link to="/devices">← Back to devices</Link></p><h1>{device?.name || deviceId}</h1><p><code>{deviceId}</code></p></div><span className={`status-pill ${liveStatus === 'live' ? 'status-pill--online' : 'status-pill--offline'}`}>{liveStatus}</span></header>
    {error && <div className="alert alert--error">{error}</div>}
    {device && <>
      <section className="stat-grid">
        <article className="stat-card"><span className="stat-card__label">Current speed</span><span className="stat-card__value">{device.last_speed ?? '—'}<small> km/h</small></span></article>
        <article className="stat-card"><span className="stat-card__label">Trip distance</span><span className="stat-card__value">{(stats.distance / 1000).toFixed(2)}<small> km</small></span></article>
        <article className="stat-card"><span className="stat-card__label">Average speed</span><span className="stat-card__value">{stats.avgSpeed?.toFixed(1) ?? '—'}<small> km/h</small></span></article>
        <article className="stat-card"><span className="stat-card__label">Maximum speed</span><span className="stat-card__value">{stats.maxSpeed?.toFixed(1) ?? '—'}<small> km/h</small></span></article>
      </section>
      <section className="panel"><div className="panel__header"><h2>Live position and route</h2><span>{positions.length} points</span></div><GpsMap positions={positions.length ? positions : (device.last_latitude === null ? [] : [{ latitude: device.last_latitude, longitude: device.last_longitude, speed: device.last_speed, recorded_at: device.last_recorded_at }])} /></section>
      <section className="panel"><div className="panel__header"><h2>GPS details</h2></div><div className="device-card__metrics">
        <span className="metric">Coordinates<strong>{device.last_latitude === null ? 'No GPS fix' : `${device.last_latitude}, ${device.last_longitude}`}</strong></span><span className="metric">Altitude<strong>{device.last_altitude ?? '—'} m</strong></span><span className="metric">Heading<strong>{device.last_heading ?? '—'}°</strong></span><span className="metric">Accuracy<strong>{device.last_accuracy ?? '—'} m</strong></span><span className="metric">Satellites<strong>{device.last_satellites ?? '—'}</strong></span><span className="metric">GPS time<strong>{device.last_recorded_at ? new Date(device.last_recorded_at).toLocaleString() : '—'}</strong></span>
      </div></section>
      <section className="panel"><div className="panel__header"><h2>History and export</h2></div><div className="toolbar"><select value={rangeHours} onChange={(event) => setRangeHours(event.target.value)}><option value="1">Last hour</option><option value="6">Last 6 hours</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="all">All saved points</option></select><button onClick={() => exportHistory('csv')}>Export CSV</button><button onClick={() => exportHistory('gpx')}>Export GPX</button><button className="button--danger" onClick={deleteHistory}>Delete history</button></div></section>
      <section className="panel"><div className="panel__header"><h2>OBS overlays</h2><button onClick={createOverlay}>Create overlay</button></div>
        {overlayResult && <div className="alert alert--success"><strong>Save this URL now:</strong><br /><code>{`${window.location.origin}${overlayResult.overlay_path}`}</code></div>}
        <div className="device-list">{overlays.map((overlay) => <article className="device-card" key={overlay.id}><div className="device-card__top"><strong>{overlay.name}</strong><span>{overlay.status}</span></div><div className="device-card__actions"><button onClick={() => navigate(`/devices/${encodeURIComponent(deviceId)}/overlays/${encodeURIComponent(overlay.id)}`)}>Configure</button>{overlay.status === 'active' && <button className="button--danger" onClick={() => revokeOverlay(overlay.id)}>Revoke</button>}</div></article>)}{!overlays.length && <p>No overlays created.</p>}</div>
      </section>
      <section className="panel danger-zone"><h2>Danger zone</h2><p>Permanently removes this device, all positions, sessions and overlay configuration.</p><button className="button--danger" onClick={deleteDevice}>Delete device permanently</button></section>
    </>}
  </main>;
};

export default DeviceDetails;
