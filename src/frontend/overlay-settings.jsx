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
  statsLayout: [['cards', 'Cards'], ['compact', 'Compact line'], ['stack', 'Vertical stack']],
  statsAlign: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']],
  statsWidth: [['natural', 'Fit content'], ['map-width', 'Map width']],
  statsPosition: [['above-map', 'Above map'], ['below-map', 'Below map']],
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
const STAT_FIELDS = STAT_OPTIONS.map(([field]) => field);
const HUD_ANCHORS = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];

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
        const normalized = ['dark', 'transparent'].includes(savedConfig.mapTheme)
          ? { ...savedConfig, mapTheme: savedConfig.mapTheme === 'dark' ? 'night' : 'standard' }
          : savedConfig;
        setConfig({ ...normalized, statsOrder: Array.isArray(normalized.statsOrder) ? normalized.statsOrder : STAT_FIELDS, hudAnchor: normalized.hudAnchor || `${normalized.statsPosition === 'above-map' ? 'top' : 'bottom'}-${normalized.statsAlign || 'left'}` });
      })
      .catch((requestError) => setError(requestError.response?.data?.message || requestError.message));
  }, [deviceId, navigate, overlayId]);

  const update = (field, value) => setConfig((current) => ({ ...current, [field]: value }));
  const updateStat = (field, value) => setConfig((current) => ({
    ...current,
    stats: { ...current.stats, [field]: value }
  }));
  const setHudAnchor = (hudAnchor) => {
    const [vertical, horizontal] = hudAnchor.split('-');
    update('hudAnchor', hudAnchor);
    if (vertical !== 'middle') { update('statsPosition', vertical === 'top' ? 'above-map' : 'below-map'); update('statsAlign', horizontal); }
  };
  const reorderStat = (field, direction) => setConfig((current) => {
    const order = [...(current.statsOrder || STAT_FIELDS)]; const from = order.indexOf(field); const to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return current;
    [order[from], order[to]] = [order[to], order[from]];
    return { ...current, statsOrder: order };
  });
  const onStatDrop = (event, target) => {
    const source = event.dataTransfer.getData('text/plain');
    if (!source || source === target) return;
    setConfig((current) => {
      const order = [...(current.statsOrder || STAT_FIELDS)]; const from = order.indexOf(source); const to = order.indexOf(target);
      if (from < 0 || to < 0) return current;
      order.splice(from, 1); order.splice(to, 0, source);
      return { ...current, statsOrder: order };
    });
  };
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

  const choiceButtons = (field) => (
    <div className="overlay-settings__choices">
      {OPTIONS[field].map(([value, label]) => (
        <button className={config[field] === value ? 'is-selected' : ''} type="button" key={value} onClick={() => update(field, value)}>{label}</button>
      ))}
    </div>
  );

  const choiceGroup = (field, title) => (
    <section className="overlay-settings__section">
      <h2>{title}</h2>
      {choiceButtons(field)}
    </section>
  );
  const telemetryRows = (config.statsOrder || STAT_FIELDS).map((field) => {
    const [, label, hint] = STAT_OPTIONS.find(([name]) => name === field);
    const index = (config.statsOrder || STAT_FIELDS).indexOf(field);
    return <div className="overlay-settings__stat-row" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', field)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onStatDrop(event, field)} key={field}>
      <label><input type="checkbox" checked={config.stats[field]} onChange={(event) => updateStat(field, event.target.checked)} /><span><strong>{label}</strong><small>{hint}</small></span></label>
      <span className="overlay-settings__stat-order"><button type="button" disabled={index === 0} onClick={() => reorderStat(field, -1)} aria-label={`Move ${label} earlier`}>{config.statsLayout === 'stack' ? '↑' : '←'}</button><button type="button" disabled={index === STAT_FIELDS.length - 1} onClick={() => reorderStat(field, 1)} aria-label={`Move ${label} later`}>{config.statsLayout === 'stack' ? '↓' : '→'}</button></span>
    </div>;
  });

  return (
    <main className="overlay-settings">
      <Link className="back-link" to={`/devices/${encodeURIComponent(deviceId)}`}><span aria-hidden="true">←</span> Back to device</Link>
      <h1>Overlay Studio</h1>
      <p>Compose the map and live telemetry for <strong>{overlay.name}</strong>.</p>
      {error && <p className="overlay-settings__error">{error}</p>}
      {message && <p className="overlay-settings__success">{message}</p>}

      <section className="overlay-settings__section overlay-settings__studio-intro">
        <h2>Live composition</h2><p className="overlay-settings__hint">This is the scene sent to OBS. Select the telemetry HUD directly on the canvas, then place it around the map. Every enabled statistic appears here in its saved order.</p>
      </section>

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
        <h2>Scene canvas</h2>
        <label>Simulate speed: {previewSpeed} km/h
          <input type="range" min="0" max="300" value={previewSpeed} onChange={(event) => setPreviewSpeed(Number(event.target.value))} />
        </label>
        <div className={`overlay-settings__scene overlay-settings__scene--${config.hudAnchor || 'bottom-left'} overlay-settings__scene--${config.statsLayout}`} style={{ '--scene-hud-text-size': `${Math.max(8, Math.round(config.statsTextSize * 0.72))}px` }}>
          <div className="overlay-settings__scene-stage">
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
          <div className="overlay-settings__scene-hud" aria-label="Telemetry HUD preview">
            {(config.statsOrder || STAT_FIELDS).filter((field) => config.stats[field]).map((field) => <span draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', field)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onStatDrop(event, field)} key={field}>{STAT_OPTIONS.find(([name]) => name === field)[1]}</span>)}
          </div>
          <div className="overlay-settings__scene-placement" role="group" aria-label="Place telemetry HUD">
            {HUD_ANCHORS.map((anchor) => <button type="button" key={anchor} className={config.hudAnchor === anchor ? 'is-selected' : ''} onClick={() => setHudAnchor(anchor)} aria-label={`Place telemetry ${anchor.replace('-', ' ')}`} title={anchor.replace('-', ' ')}>●</button>)}
          </div>
          </div>
          <aside className="overlay-settings__scene-inspector">
            <strong>Telemetry HUD</strong><small>Toggle, drag or use arrows to set the order.</small>
            <div className="overlay-settings__stats">{telemetryRows}</div>
            <div className="overlay-settings__scene-controls"><div><span>Style</span>{choiceButtons('statsLayout')}</div><div><span>Width</span>{choiceButtons('statsWidth')}</div><label>Text size: {config.statsTextSize}px<input type="range" min="10" max="28" value={config.statsTextSize} onChange={(event) => update('statsTextSize', Number(event.target.value))} /></label></div>
          </aside>
        </div>
      </section>
      <section className="overlay-settings__section overlay-settings__legacy-hud">
        <h2>Telemetry HUD</h2>
        <p className="overlay-settings__hint">Only enabled values with GPS data will be shown in OBS.</p>
        <div className="overlay-settings__stats">
          {(config.statsOrder || STAT_FIELDS).map((field) => {
            const [, label, hint] = STAT_OPTIONS.find(([name]) => name === field);
            const index = (config.statsOrder || STAT_FIELDS).indexOf(field);
            return <div className="overlay-settings__stat-row" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', field)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onStatDrop(event, field)} key={field}>
            <label>
              <input type="checkbox" checked={config.stats[field]} onChange={(event) => updateStat(field, event.target.checked)} />
              <span><strong>{label}</strong><small>{hint}</small></span>
            </label>
              <span className="overlay-settings__stat-order"><button type="button" disabled={index === 0} onClick={() => reorderStat(field, -1)} aria-label={`Move ${label} earlier`}>{config.statsLayout === 'stack' ? '↑' : '←'}</button><button type="button" disabled={index === STAT_FIELDS.length - 1} onClick={() => reorderStat(field, 1)} aria-label={`Move ${label} later`}>{config.statsLayout === 'stack' ? '↓' : '→'}</button></span>
            </div>;
          })}
        </div>
        <div className="overlay-settings__stat-layout-controls">
          <div>
            <h3>Style</h3>
            {choiceButtons('statsLayout')}
          </div>
          <div>
            <h3>Width</h3>
            {choiceButtons('statsWidth')}
          </div>
        </div>
        <label>Statistics text size: {config.statsTextSize}px
          <input type="range" min="10" max="28" value={config.statsTextSize} onChange={(event) => update('statsTextSize', Number(event.target.value))} />
        </label>
      </section>
      <button className="overlay-settings__save" type="button" onClick={save}>Save appearance</button>
    </main>
  );
};

export default OverlaySettings;
