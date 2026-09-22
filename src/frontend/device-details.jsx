import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import GpsMap from './gps-map.jsx';

const distanceMeters = (a, b) => {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(Number(b.latitude) - Number(a.latitude));
  const dLon = rad(Number(b.longitude) - Number(a.longitude));
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(Number(a.latitude))) * Math.cos(rad(Number(b.latitude))) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const formatSpeed = (value) => {
  const speed = Number(value);
  return Number.isFinite(speed) ? speed.toFixed(1) : '—';
};

const CollapsiblePanel = ({ title, hint, badge, defaultOpen = false, className = '', children }) => (
  <details className={`panel collapsible-panel ${className}`.trim()} open={defaultOpen}>
    <summary className="collapsible-panel__summary">
      <div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>
      <div className="collapsible-panel__meta">{badge}</div>
    </summary>
    <div className="collapsible-panel__content">{children}</div>
  </details>
);

const DeviceDetails = () => {
  const { deviceId } = useParams();
  const navigate = useNavigate();
  const [device, setDevice] = useState(null);
  const [positions, setPositions] = useState([]);
  const [rangeHours, setRangeHours] = useState('24');
  const [routeMode, setRouteMode] = useState(() => window.localStorage.getItem(`stream-gps-route-mode:${deviceId}`) || 'raw');
  const [routeInfo, setRouteInfo] = useState(null);
  const [liveStatus, setLiveStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [overlayResult, setOverlayResult] = useState(null);
  const [overlays, setOverlays] = useState([]);
  const [credentials, setCredentials] = useState({ device_key: null, overlays: [] });
  const [visibleKeys, setVisibleKeys] = useState({});
  const [chatCommands, setChatCommands] = useState([]);
  const [savingCommand, setSavingCommand] = useState(null);
  const token = sessionStorage.getItem('accessToken');
  const headers = { Authorization: `Bearer ${token}` };

  const loadDevice = useCallback(async () => {
    if (!token) { navigate('/login', { replace: true }); return; }
    const params = new URLSearchParams({ limit: '5000' });
    if (routeMode === 'smart') { params.set('route', 'smart'); params.set('max_points', '2500'); }
    if (rangeHours !== 'all') params.set('from', new Date(Date.now() - Number(rangeHours) * 3600000).toISOString());
    try {
      const [deviceResponse, historyResponse, overlaysResponse, credentialsResponse, commandsResponse] = await Promise.all([
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}`, { headers }),
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/history?${params}`, { headers }),
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/overlays`, { headers }),
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/credentials`, { headers }),
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/chat-commands`, { headers })
      ]);
      setDevice(deviceResponse.data.device); setPositions(historyResponse.data.positions); setRouteInfo(historyResponse.data.route || null); setOverlays(overlaysResponse.data.overlays); setCredentials(credentialsResponse.data); setChatCommands(commandsResponse.data.commands || []); setError(null);
    } catch (requestError) {
      if (requestError.response?.status === 401) { sessionStorage.removeItem('accessToken'); navigate('/login', { replace: true }); return; }
      setError(requestError.response?.data?.message || requestError.message);
    } finally { setLoading(false); }
  }, [deviceId, navigate, rangeHours, routeMode, token]);

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
          setPositions((current) => [...current.filter((item) => item.recorded_at !== next.recorded_at), next].slice(-(routeMode === 'smart' ? 2500 : 5000)));
        });
        source.onerror = () => setLiveStatus('reconnecting');
        renewal = window.setTimeout(() => { source?.close(); connect(); }, 240000);
      } catch { setLiveStatus('unavailable'); }
    };
    connect();
    return () => { cancelled = true; source?.close(); window.clearTimeout(renewal); };
  }, [deviceId, routeMode, token]);

  const changeRouteMode = (mode) => {
    window.localStorage.setItem(`stream-gps-route-mode:${deviceId}`, mode);
    setRouteMode(mode);
  };

  const stats = useMemo(() => {
    const speeds = positions.map((p) => Number(p.speed)).filter(Number.isFinite);
    const distance = positions.slice(1).reduce((sum, point, index) => sum + distanceMeters(positions[index], point), 0);
    return { distance, maxSpeed: speeds.length ? Math.max(...speeds) : null, avgSpeed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null };
  }, [positions]);

  const createOverlay = async () => {
    try {
      const response = await axios.post(`/api/v1/devices/${encodeURIComponent(deviceId)}/overlays`, { name: `${device?.name || deviceId} OBS` }, { headers });
      setOverlayResult(response.data); setOverlays((current) => [response.data.overlay, ...current]);
      setCredentials((current) => ({ ...current, overlays: [{ ...response.data.overlay, access_key: response.data.access_key }, ...current.overlays] }));
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const revokeOverlay = async (overlayId) => {
    if (!window.confirm('Disable this OBS overlay? Its URL will stop working immediately.')) return;
    try { await axios.post(`/api/v1/overlays/${encodeURIComponent(overlayId)}/revoke`, {}, { headers }); setOverlays((current) => current.map((o) => o.id === overlayId ? { ...o, status: 'revoked' } : o)); setCredentials((current) => ({ ...current, overlays: current.overlays.map((o) => o.id === overlayId ? { ...o, status: 'revoked' } : o) })); }
    catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const replaceOverlayKey = async (overlayId) => {
    if (!window.confirm('Replace this pull key? The current OBS URL will stop working immediately.')) return;
    try {
      const response = await axios.post(`/api/v1/overlays/${encodeURIComponent(overlayId)}/rotate-key`, {}, { headers });
      setCredentials((current) => ({ ...current, overlays: current.overlays.map((o) => o.id === overlayId ? { ...o, access_key: response.data.access_key } : o) }));
      setVisibleKeys((current) => ({ ...current, [overlayId]: true })); setError(null);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const setOverlayVisibility = async (overlayId, visible) => {
    try {
      await axios.patch(`/api/v1/overlays/${encodeURIComponent(overlayId)}/visibility`, { visible }, { headers });
      setOverlays((current) => current.map((overlay) => overlay.id === overlayId ? { ...overlay, visible } : overlay));
      setError(null);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const deleteOverlay = async (overlayId) => {
    if (!window.confirm('Permanently delete this overlay? This cannot be undone.')) return;
    try {
      await axios.delete(`/api/v1/overlays/${encodeURIComponent(overlayId)}`, { headers });
      setOverlays((current) => current.filter((o) => o.id !== overlayId));
      setCredentials((current) => ({ ...current, overlays: current.overlays.filter((o) => o.id !== overlayId) }));
      setError(null);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const updatePublicSharing = async (enabled) => {
    try {
      const response = await axios.patch(`/api/v1/devices/${encodeURIComponent(deviceId)}/public-sharing`, { enabled }, { headers });
      setDevice((current) => ({ ...current, ...response.data.sharing })); setError(null);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  const changeCommand = (action, change) => {
    setChatCommands((current) => current.map((rule) => rule.action === action ? { ...rule, ...change } : rule));
  };

  const saveCommand = async (rule) => {
    setSavingCommand(rule.action);
    try {
      const response = await axios.patch(`/api/v1/devices/${encodeURIComponent(deviceId)}/chat-commands/${encodeURIComponent(rule.action)}`, {
        enabled: rule.enabled,
        command: rule.command,
        aliases: String(rule.aliasesText ?? (rule.aliases || []).join(', ')).split(',').map((alias) => alias.trim()).filter(Boolean),
        minimum_role: rule.minimum_role,
        cooldown_seconds: Number(rule.cooldown_seconds),
        response_enabled: rule.response_enabled
      }, { headers });
      setChatCommands((current) => current.map((item) => item.action === rule.action ? { ...response.data.command, label: item.label, aliasesText: response.data.command.aliases.join(', ') } : item));
      setError(null);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
    finally { setSavingCommand(null); }
  };

  const regeneratePublicLink = async () => {
    if (!window.confirm('Regenerate the public map link? The previous link and QR code will stop working immediately.')) return;
    try {
      const response = await axios.post(`/api/v1/devices/${encodeURIComponent(deviceId)}/public-sharing/rotate`, {}, { headers });
      setDevice((current) => ({ ...current, ...response.data.sharing })); setError(null);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
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

  const namesForCommand = (rule) => [rule.command, ...(String(rule.aliasesText ?? (rule.aliases || []).join(', ')).split(','))]
    .map((name) => name.trim().toLowerCase()).filter(Boolean);
  const commandConflict = (rule) => {
    const names = namesForCommand(rule);
    if (new Set(names).size !== names.length) return 'The command and aliases must be unique.';
    const conflict = chatCommands.find((other) => other.action !== rule.action && namesForCommand(other).some((name) => names.includes(name)));
    return conflict ? `Already used by ${conflict.label}.` : null;
  };

  if (loading && !device) return <main><p>Loading device...</p></main>;
  const publicMapUrl = device?.public_share_id ? `${window.location.origin}/map/${device.public_share_id}` : null;
  return <main>
    <header className="page-header"><div><Link className="back-link" to="/devices"><span aria-hidden="true">←</span> Back to devices</Link><h1>{device?.name || deviceId}</h1><p><code>{deviceId}</code></p></div><span className={`status-pill ${liveStatus === 'live' ? 'status-pill--online' : 'status-pill--offline'}`}>{liveStatus}</span></header>
    {error && <div className="alert alert--error">{error}</div>}
    {device && <>
      <section className="stat-grid">
        <article className="stat-card"><span className="stat-card__label">Current speed</span><span className="stat-card__value">{formatSpeed(device.last_speed)}<small> km/h</small></span></article>
        <article className="stat-card"><span className="stat-card__label">Trip distance</span><span className="stat-card__value">{(stats.distance / 1000).toFixed(2)}<small> km</small></span></article>
        <article className="stat-card"><span className="stat-card__label">Average speed</span><span className="stat-card__value">{stats.avgSpeed?.toFixed(1) ?? '—'}<small> km/h</small></span></article>
        <article className="stat-card"><span className="stat-card__label">Maximum speed</span><span className="stat-card__value">{stats.maxSpeed?.toFixed(1) ?? '—'}<small> km/h</small></span></article>
      </section>
      <CollapsiblePanel title="Live position and route" badge={routeInfo ? `${routeInfo.rendered_points} / ${routeInfo.source_points} points` : `${positions.length} points`} defaultOpen><div className="route-mode"><div><strong>Route rendering</strong><p className="panel__hint">Raw keeps the existing point-by-point view. Smart route preserves turns while reducing map load.</p></div><div className="route-mode__choices"><button type="button" className={routeMode === 'raw' ? '' : 'button--secondary'} onClick={() => changeRouteMode('raw')}>Raw / legacy</button><button type="button" className={routeMode === 'smart' ? '' : 'button--secondary'} onClick={() => changeRouteMode('smart')}>Smart route (beta)</button></div></div>{routeInfo && <p className="panel__hint route-mode__info">Showing {routeInfo.rendered_points} meaningful points from {routeInfo.source_points}{routeInfo.source_sampled ? ' (source sampled for a very long range)' : ''}. {routeInfo.segments > 1 ? `${routeInfo.segments} time-separated route segments are not joined.` : ''}</p>}<GpsMap positions={positions.length ? positions : (device.last_latitude === null ? [] : [{ latitude: device.last_latitude, longitude: device.last_longitude, speed: device.last_speed, recorded_at: device.last_recorded_at }])} showHistoryMarkers={routeMode === 'raw'} /></CollapsiblePanel>
      <CollapsiblePanel title="GPS details" hint="Latest position data received from this device."><div className="device-card__metrics">
        <span className="metric">Coordinates<strong>{device.last_latitude === null ? 'No GPS fix' : `${device.last_latitude}, ${device.last_longitude}`}</strong></span><span className="metric">Altitude<strong>{device.last_altitude ?? '—'} m</strong></span><span className="metric">Heading<strong>{device.last_heading ?? '—'}°</strong></span><span className="metric">Accuracy<strong>{device.last_accuracy ?? '—'} m</strong></span><span className="metric">Satellites<strong>{device.last_satellites ?? '—'}</strong></span><span className="metric">GPS time<strong>{device.last_recorded_at ? new Date(device.last_recorded_at).toLocaleString() : '—'}</strong></span>
      </div></CollapsiblePanel>
      <CollapsiblePanel title="History and export" hint="Download or permanently remove saved GPS records."><div className="toolbar"><select value={rangeHours} onChange={(event) => setRangeHours(event.target.value)}><option value="1">Last hour</option><option value="6">Last 6 hours</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="all">All saved points</option></select><button onClick={() => exportHistory('csv')}>Export CSV</button><button onClick={() => exportHistory('gpx')}>Export GPX</button><button className="button--danger" onClick={deleteHistory}>Delete history</button></div></CollapsiblePanel>
      <CollapsiblePanel title="Your keys" hint="Secrets are visible only to the device owner and never appear in public links.">
        <div className="key-list"><div className="key-row"><label>Push key <small>for the GPS device</small></label>{credentials.device_key ? <div className="key-field"><input readOnly type="text" autoComplete="off" className={visibleKeys.device ? '' : 'key-field__secret'} value={credentials.device_key} /><button className="button--secondary" onClick={() => setVisibleKeys((current) => ({ ...current, device: !current.device }))}>{visibleKeys.device ? 'Hide' : 'Show'}</button><button onClick={() => navigator.clipboard.writeText(credentials.device_key)}>Copy</button></div> : <p className="panel__hint">Waiting for the existing GPS device to authenticate. Refresh after its next upload; replace the GPS key only if the original configuration is no longer available.</p>}</div>
          {credentials.overlays.map((credential) => <div className="key-row" key={credential.id}><label>Pull key — {credential.name} <small>{credential.status}</small></label>{credential.status !== 'active' ? <p className="panel__hint">This overlay is disabled. Delete it below when it is no longer needed.</p> : credential.access_key ? <div className="key-field"><input readOnly type="text" autoComplete="off" className={visibleKeys[credential.id] ? '' : 'key-field__secret'} value={credential.access_key} /><button className="button--secondary" onClick={() => setVisibleKeys((current) => ({ ...current, [credential.id]: !current[credential.id] }))}>{visibleKeys[credential.id] ? 'Hide' : 'Show'}</button><button onClick={() => navigator.clipboard.writeText(credential.access_key)}>Copy</button></div> : <div><p className="panel__hint">Open the existing OBS URL once and refresh this page to import its key, or replace the pull key now.</p><button className="button--secondary" onClick={() => replaceOverlayKey(credential.id)}>Replace pull key</button></div>}</div>)}
          {!credentials.overlays.length && <p className="panel__hint">Create an OBS overlay to issue a pull key.</p>}
        </div>
      </CollapsiblePanel>
      <CollapsiblePanel title="Viewer map" hint="Share only your current position. Saved route history remains private." badge={<span className={`status-pill ${device.public_share_enabled ? 'status-pill--online' : 'status-pill--offline'}`}>{device.public_share_enabled ? 'sharing on' : 'sharing off'}</span>}>
        <div className="sharing-actions"><button onClick={() => updatePublicSharing(!device.public_share_enabled)} className={device.public_share_enabled ? 'button--danger' : ''}>{device.public_share_enabled ? 'Stop sharing' : 'Start sharing'}</button>{device.public_share_id && <button className="button--secondary" onClick={regeneratePublicLink}>Regenerate link</button>}</div>
        {publicMapUrl && <div className="share-link"><div><strong>Public viewer link</strong><code>{publicMapUrl}</code><div className="sharing-actions"><button onClick={() => navigator.clipboard.writeText(publicMapUrl)}>Copy link</button><a className="button button--secondary" href={publicMapUrl} target="_blank" rel="noreferrer">Open preview</a></div>{!device.public_share_enabled && <p className="panel__hint">This link is currently disabled and exposes no location. Starting sharing will reactivate it.</p>}</div>{device.public_share_enabled && <div className="share-qr"><QRCodeSVG value={publicMapUrl} size={150} level="M" title="QR code for the public viewer map" /></div>}</div>}
      </CollapsiblePanel>
      <details className="panel chat-commands-panel">
        <summary className="chat-commands-panel__summary">
          <div><h2>Chat command automation</h2><p>Configure which chat actions can control this device.</p></div>
          <span>{chatCommands.filter((rule) => rule.enabled).length} active · Configure</span>
        </summary>
        <div className="chat-commands-panel__content">
          <p className="panel__hint">Commands stay inactive until a Kick or Twitch channel is explicitly connected in Account settings. A chat message can never grant its sender administrator access.</p>
          <div className="command-list">{chatCommands.map((rule) => <article className="command-card" key={rule.action}>
          <div className="command-card__header"><div><strong>{rule.label}</strong><small>{rule.action === 'panic' ? 'Always enabled; restricted to owner or admin.' : 'Applies to both connected chat platforms.'}</small></div><label className="switch"><input type="checkbox" checked={rule.enabled} disabled={rule.action === 'panic'} onChange={(event) => changeCommand(rule.action, { enabled: event.target.checked })} /><span /></label></div>
          <div className="command-grid"><label>Command<input value={rule.command} onChange={(event) => changeCommand(rule.action, { command: event.target.value })} /></label><label>Aliases <small>comma-separated</small><input value={rule.aliasesText ?? (rule.aliases || []).join(', ')} onChange={(event) => changeCommand(rule.action, { aliasesText: event.target.value })} placeholder="!mapa, !where" /></label><label>Minimum role<select value={rule.minimum_role} onChange={(event) => changeCommand(rule.action, { minimum_role: event.target.value })} disabled={rule.action === 'panic'}><option value="viewer">Viewer</option><option value="moderator">Moderator</option><option value="admin">Trusted admin</option><option value="owner">Channel owner</option></select></label><label>Cooldown (seconds)<input type="number" min="0" max="3600" value={rule.cooldown_seconds} onChange={(event) => changeCommand(rule.action, { cooldown_seconds: event.target.value })} /></label></div>
          {commandConflict(rule) && <p className="command-card__error">{commandConflict(rule)}</p>}
          <div className="command-card__footer"><label className="checkbox-label"><input type="checkbox" checked={rule.response_enabled} onChange={(event) => changeCommand(rule.action, { response_enabled: event.target.checked })} /> Reply in chat</label><button type="button" onClick={() => saveCommand(rule)} disabled={savingCommand === rule.action || Boolean(commandConflict(rule))}>{savingCommand === rule.action ? 'Saving...' : 'Save command'}</button></div>
          </article>)}</div>
        </div>
      </details>
      <CollapsiblePanel title="OBS overlays" hint="Create and manage browser-source overlays for this device." badge={`${overlays.length} total`}>
        <div className="panel__header"><h2>Available overlays</h2><button onClick={createOverlay}>Create overlay</button></div>
        {overlayResult && <div className="alert alert--success"><strong>OBS URL created:</strong><br /><code>{`${window.location.origin}${overlayResult.overlay_path}`}</code></div>}
        <div className="device-list">{overlays.map((overlay) => {
          const pullKey = credentials.overlays.find((item) => item.id === overlay.id)?.access_key;
          const obsUrl = pullKey ? `${window.location.origin}/overlay/${overlay.id}?key=${encodeURIComponent(pullKey)}` : null;
          const showUrl = visibleKeys[`url-${overlay.id}`];
          return <article className="device-card" key={overlay.id}><div className="device-card__top"><strong>{overlay.name}</strong><span>{overlay.status}</span></div>
            {overlay.status === 'active' && obsUrl && <div className="obs-link"><button className="button--secondary button--small" onClick={() => setVisibleKeys((current) => ({ ...current, [`url-${overlay.id}`]: !showUrl }))}>{showUrl ? 'Hide OBS link' : 'Generate OBS link'}</button>{showUrl && <><code>{obsUrl}</code><div className="sharing-actions"><button className="button--small" onClick={() => navigator.clipboard.writeText(obsUrl)}>Copy OBS link</button><a className="button button--secondary button--small" href={obsUrl} target="_blank" rel="noreferrer">Open preview</a></div></>}</div>}
            {overlay.status === 'active' && !obsUrl && <p className="panel__hint">Import or replace the pull key in Your keys to generate the complete OBS link.</p>}
            <div className="device-card__actions">{overlay.status === 'active' && <button onClick={() => navigate(`/devices/${encodeURIComponent(deviceId)}/overlays/${encodeURIComponent(overlay.id)}`)}>Configure</button>}{overlay.status === 'active' && <button className="button--secondary" onClick={() => setOverlayVisibility(overlay.id, overlay.visible === false)}> {overlay.visible === false ? 'Show in OBS' : 'Hide in OBS'}</button>}{overlay.status === 'active' && <button className="button--secondary" onClick={() => replaceOverlayKey(overlay.id)}>Replace pull key</button>}{overlay.status === 'active' && <button className="button--secondary" onClick={() => revokeOverlay(overlay.id)}>Disable</button>}<button className="button--danger" onClick={() => deleteOverlay(overlay.id)}>Delete</button></div></article>;
        })}{!overlays.length && <p>No overlays created.</p>}</div>
      </CollapsiblePanel>
      <CollapsiblePanel title="Danger zone" hint="Permanently removes this device, history, sessions and overlay configuration." className="danger-zone"><button className="button--danger" onClick={deleteDevice}>Delete device permanently</button></CollapsiblePanel>
    </>}
  </main>;
};

export default DeviceDetails;
