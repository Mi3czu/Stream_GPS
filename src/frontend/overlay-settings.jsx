import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate, useParams } from 'react-router-dom';
import './overlay-settings.css';
import GpsMap, { mapAttributionLabel } from './gps-map.jsx';

const OPTIONS = {
  mapTheme: [['standard', 'Standard'], ['satellite', 'Satellite'], ['night', 'Night (OSM filter)']],
  textTheme: [['glass', 'Glass'], ['light', 'Light'], ['dark', 'Dark']],
  fontFamily: [['monospace', 'Standard (mono)'], ['Arial, sans-serif', 'Arial'], ['Roboto, sans-serif', 'Roboto'], ['Inter, sans-serif', 'Inter'], ['Oswald, sans-serif', 'Oswald']],
  mapShape: [['round', 'Round'], ['square', 'Square']],
  mapRenderMode: [['legacy', 'Legacy'], ['rounded', 'Rounded + drift correction (experimental)']],
  statsLayout: [['cards', 'Cards (recommended)'], ['compact', 'Compact line']],
  statsAlign: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']],
  statsWidth: [['natural', 'Fit content'], ['map-width', 'Map width']],
  trailDurationMinutes: [[0, 'Off'], [1, 'Last 1 minute'], [5, 'Last 5 minutes'], [15, 'Last 15 minutes']]
};

const STAT_OPTIONS = [
  ['speed', 'Speed', 'Current GPS speed'],
  ['direction', 'Direction', 'Compass direction from GPS heading'],
  ['altitude', 'Altitude', 'Meters above sea level'],
  ['accuracy', 'Accuracy', 'GPS accuracy in meters (estimated from HDOP when needed)'],
  ['gpsSignal', 'GPS signal', 'Number of satellites'],
  ['localTime', 'Local time', 'Time in the browser timezone'],
  ['maxSpeed', 'Max speed', 'Highest speed in the current session'],
  ['avgSpeed', 'Avg speed', 'Average speed in the current session'],
  ['tripDistance', 'Trip distance', 'Distance calculated in the current session']
  ,['location', 'Location', 'Nearest locality from the built-in Europe database · data © GeoNames']
];

const OverlaySettings = () => {
  const { deviceId, overlayId } = useParams();
  const navigate = useNavigate();
  const [overlay, setOverlay] = useState(null);
  const [config, setConfig] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [previewSpeed, setPreviewSpeed] = useState(30);

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');
    if (!token) return navigate('/login', { replace: true });
    axios.get(`/api/v1/overlays/${encodeURIComponent(overlayId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        if (response.data.overlay.device_id !== deviceId) return navigate('/devices', { replace: true });
        const savedConfig = response.data.overlay.config;
        // Retired experimental/provider-backed selections are made safe as
        // soon as an overlay is opened for editing.
        setOverlay(response.data.overlay);
        setConfig(['dark', 'transparent'].includes(savedConfig.mapTheme)
          ? { ...savedConfig, mapTheme: savedConfig.mapTheme === 'dark' ? 'night' : 'standard' }
          : savedConfig);
      })
      .catch((requestError) => setError(requestError.response?.data?.message || requestError.message));
  }, [deviceId, navigate, overlayId]);

  const update = (field, value) => setConfig((current) => ({ ...current, [field]: value }));
  const updateStat = (field, value) => setConfig((current) => ({
    ...current,
    stats: { ...current.stats, [field]: value }
  }));
  const save = async () => {
    const token = sessionStorage.getItem('accessToken');
    try {
      const response = await axios.patch(`/api/v1/overlays/${encodeURIComponent(overlayId)}`, { config }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setConfig(response.data.overlay.config);
      setMessage('Saved. OBS will use the new appearance on its next refresh.');
      setError(null);
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
      setMessage(null);
    }
  };

  if (!overlay || !config) return <main><p>{error || 'Loading overlay settings...'}</p></main>;

  const choiceGroup = (field, title) => (
    <section className="overlay-settings__section">
      <h2>{title}</h2>
      <div className="overlay-settings__choices">
        {OPTIONS[field].map(([value, label]) => (
          <button className={config[field] === value ? 'is-selected' : ''} type="button" key={value} onClick={() => update(field, value)}>{label}</button>
        ))}
      </div>
    </section>
  );

  return (
    <main className="overlay-settings">
      <Link className="back-link" to={`/devices/${encodeURIComponent(deviceId)}`}><span aria-hidden="true">←</span> Back to device</Link>
      <h1>Overlay settings</h1>
      <p>{overlay.name}</p>
      {error && <p className="overlay-settings__error">{error}</p>}
      {message && <p className="overlay-settings__success">{message}</p>}

      {choiceGroup('mapTheme', 'Map theme')}
      {choiceGroup('textTheme', 'Text theme')}
      <section className="overlay-settings__section">
        <h2>Text color</h2>
        <input aria-label="Text color" type="color" value={config.textColor} onChange={(event) => update('textColor', event.target.value)} />
      </section>
      {choiceGroup('fontFamily', 'Font')}
      {choiceGroup('mapShape', 'Map shape')}
      {choiceGroup('mapRenderMode', 'Map rendering')}
      <p className="overlay-settings__hint">Rounded mode smooths visible corners and stabilizes very-low-speed GPS drift only in this overlay. Legacy shows raw positions unchanged.</p>
      {choiceGroup('trailDurationMinutes', 'Fading route trail')}
      <p className="overlay-settings__hint">The trail is visible only in this OBS overlay. Older fragments fade out and it never exposes the full private route history.</p>
      {choiceGroup('statsLayout', 'Statistics layout')}
      {choiceGroup('statsAlign', 'Align statistics')}
      {choiceGroup('statsWidth', 'Statistics width')}
      <section className="overlay-settings__section">
        <h2>Map size: {config.mapSize}px</h2>
        <input type="range" min="200" max="600" step="10" value={config.mapSize} onChange={(event) => update('mapSize', Number(event.target.value))} />
      </section>
      <section className="overlay-settings__section">
        <h2>Map opacity: {config.mapOpacity}%</h2>
        <input type="range" min="10" max="100" step="5" value={config.mapOpacity} onChange={(event) => update('mapOpacity', Number(event.target.value))} />
        <p className="overlay-settings__hint">Only map tiles become transparent. The location marker, border and statistics remain clear in OBS.</p>
      </section>
      <section className="overlay-settings__section">
        <h2>Border color</h2>
        <input aria-label="Border color" type="color" value={config.borderColor} onChange={(event) => update('borderColor', event.target.value)} />
      </section>
      <section className="overlay-settings__section">
        <h2>Zoom</h2>
        <label className="overlay-settings__toggle">
          <input type="checkbox" checked={config.autoZoom} onChange={(event) => update('autoZoom', event.target.checked)} />
          Auto-zoom
        </label>
        <p className="overlay-settings__hint">Zooms out as speed rises and zooms in at lower speed.</p>
        <label>Min speed (zoomed in): {config.minSpeed} km/h
          <input type="range" min="0" max={config.maxSpeed - 1} value={config.minSpeed} onChange={(event) => update('minSpeed', Number(event.target.value))} />
        </label>
        <label>Max speed (zoomed out): {config.maxSpeed} km/h
          <input type="range" min={config.minSpeed + 1} max="300" value={config.maxSpeed} onChange={(event) => update('maxSpeed', Number(event.target.value))} />
        </label>
        <label>Max zoom (zoomed in): {config.maxZoom}
          <input type="range" min={config.minZoom + 1} max="19" value={config.maxZoom} onChange={(event) => update('maxZoom', Number(event.target.value))} />
        </label>
        <label>Min zoom (zoomed out): {config.minZoom}
          <input type="range" min="3" max={config.maxZoom - 1} value={config.minZoom} onChange={(event) => update('minZoom', Number(event.target.value))} />
        </label>
      </section>
      <section className="overlay-settings__section">
        <h2>Preview</h2>
        <label>Simulate speed: {previewSpeed} km/h
          <input type="range" min="0" max="300" value={previewSpeed} onChange={(event) => setPreviewSpeed(Number(event.target.value))} />
        </label>
        <div className={`overlay-settings__preview overlay-settings__preview--${config.mapShape}`} style={{ '--preview-border': config.borderColor }}>
          <GpsMap
            positions={[{ latitude: 52.2286, longitude: 21.0085, recorded_at: new Date(Date.now() - 180000).toISOString() }, { latitude: 52.2291, longitude: 21.0102, recorded_at: new Date(Date.now() - 90000).toISOString() }, { latitude: 52.2297, longitude: 21.0122, speed: previewSpeed, recorded_at: new Date().toISOString() }]}
            mapTheme={config.mapTheme}
            size={240}
            zoomConfig={config}
            zoomControl={false}
            attributionControl={false}
            mapOpacity={config.mapOpacity}
            fadingTrail={config.trailDurationMinutes > 0}
            showHistoryMarkers={false}
            roundedCorners={config.mapRenderMode === 'rounded'}
            stationaryDriftCorrection={config.mapRenderMode === 'rounded'}
            followLatest
          />
          <small className="overlay-settings__attribution">{mapAttributionLabel(config.mapTheme)}</small>
        </div>
      </section>
      <section className="overlay-settings__section">
        <h2>Stats and layout</h2>
        <p className="overlay-settings__hint">Only enabled values with GPS data will be shown in OBS.</p>
        <div className="overlay-settings__stats">
          {STAT_OPTIONS.map(([field, label, hint]) => (
            <label key={field}>
              <input type="checkbox" checked={config.stats[field]} onChange={(event) => updateStat(field, event.target.checked)} />
              <span><strong>{label}</strong><small>{hint}</small></span>
            </label>
          ))}
        </div>
        <label>Statistics position
          <select value={config.statsPosition} onChange={(event) => update('statsPosition', event.target.value)}>
            <option value="below-map">Below map</option>
            <option value="above-map">Above map</option>
          </select>
        </label>
        <label>Statistics text size: {config.statsTextSize}px
          <input type="range" min="10" max="28" value={config.statsTextSize} onChange={(event) => update('statsTextSize', Number(event.target.value))} />
        </label>
      </section>
      <button className="overlay-settings__save" type="button" onClick={save}>Save appearance</button>
    </main>
  );
};

export default OverlaySettings;
