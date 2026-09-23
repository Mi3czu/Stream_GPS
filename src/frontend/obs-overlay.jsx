import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useParams, useSearchParams } from 'react-router-dom';
import GpsMap, { mapAttributionLabel } from './gps-map.jsx';
import './obs-overlay.css';

const compassDirection = (heading) => {
  const value = Number(heading);
  if (!Number.isFinite(value)) return null;
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(value / 45) % 8];
};

const ObsOverlay = () => {
  const { overlayId } = useParams();
  const [searchParams] = useSearchParams();
  const [device, setDevice] = useState(null);
  const [config, setConfig] = useState(null);
  const [trail, setTrail] = useState([]);
  const trailDurationRef = useRef(0);
  const mapRenderModeRef = useRef('legacy');
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState(null);
  const [, setClockTick] = useState(0);

  useEffect(() => {
    document.documentElement.classList.add('obs-overlay-page');
    document.body.classList.add('obs-overlay-page');
    return () => {
      document.documentElement.classList.remove('obs-overlay-page');
      document.body.classList.remove('obs-overlay-page');
    };
  }, []);

  useEffect(() => {
    trailDurationRef.current = Number(config?.trailDurationMinutes || 0);
    mapRenderModeRef.current = config?.mapRenderMode || 'legacy';
  }, [config?.mapRenderMode, config?.trailDurationMinutes]);

  useEffect(() => {
    const key = searchParams.get('key');
    if (!key) {
      setError('Overlay key is missing.');
      return undefined;
    }
    let stream;
    const load = async () => {
      try {
        const response = await axios.get(`/api/v1/overlays/${encodeURIComponent(overlayId)}/data`, { params: { key } });
        setDevice(response.data.device);
        setConfig(response.data.config);
        setVisible(response.data.visible !== false);
        setError(null);
        stream = new EventSource(`/api/v1/overlays/${encodeURIComponent(overlayId)}/stream?key=${encodeURIComponent(key)}`);
        stream.addEventListener('ready', (event) => {
          const payload = JSON.parse(event.data);
          setDevice(payload.device);
          setConfig(payload.config);
          setVisible(payload.visible !== false);
        });
        stream.addEventListener('position', (event) => {
          const nextDevice = JSON.parse(event.data).device;
          setDevice(nextDevice);
          const cutoff = Date.now() - trailDurationRef.current * 60 * 1000;
          setTrail((current) => trailDurationRef.current > 0 || mapRenderModeRef.current === 'rounded' ? [...current.filter((point) => point.recorded_at !== nextDevice.recorded_at), {
            latitude: nextDevice.latitude, longitude: nextDevice.longitude, speed: nextDevice.speed, recorded_at: nextDevice.recorded_at
          }].filter((point) => new Date(point.recorded_at).getTime() >= cutoff).slice(-160) : []);
        });
        stream.addEventListener('config', (event) => {
          setConfig(JSON.parse(event.data).config);
        });
        stream.addEventListener('visibility', (event) => {
          setVisible(JSON.parse(event.data).visible !== false);
        });
      } catch {
        setError('Overlay is unavailable.');
      }
    };
    load();
    return () => stream?.close();
  }, [overlayId, searchParams]);

  useEffect(() => {
    const key = searchParams.get('key');
    if (!key || !config) return undefined;
    if (!config.trailDurationMinutes && config.mapRenderMode !== 'rounded') { setTrail([]); return undefined; }
    let cancelled = false;
    axios.get(`/api/v1/overlays/${encodeURIComponent(overlayId)}/trail`, { params: { key } })
      .then((response) => { if (!cancelled) setTrail(response.data.positions || []); })
      .catch(() => { if (!cancelled) setTrail([]); });
    return () => { cancelled = true; };
  }, [config?.mapRenderMode, config?.trailDurationMinutes, overlayId, searchParams]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  if (error) return <main className="obs-overlay"><p>{error}</p></main>;
  if (!device || !config) return <main className="obs-overlay"><p>Loading overlay...</p></main>;
  if (!visible) return <main className="obs-overlay" aria-label="Overlay hidden" />;
  const position = device.latitude === null ? [] : [{
    latitude: device.latitude,
    longitude: device.longitude,
    speed: device.speed,
    recorded_at: device.recorded_at
  }];
  const useVisualHistory = config.trailDurationMinutes > 0 || config.mapRenderMode === 'rounded';
  const mapPositions = useVisualHistory ? [...trail.filter((point) => point.recorded_at !== device.recorded_at), ...position] : position;
  const stats = [
    config.stats.speed && ['Speed', device.speed === null ? null : `${Math.round(device.speed)} km/h`],
    config.stats.direction && ['Direction', compassDirection(device.heading)],
    config.stats.altitude && ['Altitude', device.altitude === null ? null : `${Math.round(device.altitude)} m`],
    config.stats.accuracy && ['Accuracy', device.accuracy === null ? null : `${Math.round(device.accuracy)} m`],
    config.stats.gpsSignal && ['GPS', device.satellites === null ? null : `${device.satellites} satellites`],
    config.stats.localTime && ['Local time', new Date().toLocaleTimeString()],
    config.stats.maxSpeed && ['Max speed', device.max_session_speed === null ? null : `${Math.round(device.max_session_speed)} km/h`],
    config.stats.avgSpeed && ['Avg speed', device.avg_session_speed === null ? null : `${Math.round(device.avg_session_speed)} km/h`],
    config.stats.tripDistance && ['Trip distance', device.trip_distance_m === null ? null : `${(device.trip_distance_m / 1000).toFixed(2)} km`]
    ,config.stats.location && ['Location', device.locality]
  ].filter((item) => item && item[1]);
  const statsPanel = stats.length ? (
    <section className={`obs-overlay__stats obs-overlay__stats--${config.statsLayout || 'cards'} obs-overlay__stats--${config.statsAlign || 'left'} obs-overlay__stats--${config.statsWidth || 'natural'}`} style={{ '--stats-text-size': `${config.statsTextSize}px` }}>
      {stats.map(([label, value]) => <span className={label === 'Location' ? 'obs-overlay__stat obs-overlay__stat--location' : 'obs-overlay__stat'} key={label}><strong>{label}</strong><b>{value}</b></span>)}
    </section>
  ) : null;

  return (
    <main className={`obs-overlay obs-overlay--${config.textTheme}`} style={{ '--overlay-text-color': config.textColor, '--overlay-font': config.fontFamily }}><div className="obs-overlay__content" style={{ '--overlay-size': `${config.mapSize}px` }}>
      {config.statsPosition === 'above-map' && statsPanel}
      <div className={`obs-overlay__map obs-overlay__map--${config.mapShape}`} style={{ '--overlay-border': config.borderColor }}>
        <GpsMap positions={mapPositions} mapTheme={config.mapTheme} size={config.mapSize} zoomConfig={config} zoomControl={false} attributionControl={false} mapOpacity={config.mapOpacity} connectPoints={config.trailDurationMinutes > 0} showHistoryMarkers={false} fadingTrail={config.trailDurationMinutes > 0} roundedCorners={config.mapRenderMode === 'rounded'} stationaryDriftCorrection={config.mapRenderMode === 'rounded'} followLatest />
        <small className="obs-overlay__credits">{mapAttributionLabel(config.mapTheme)}</small>
      </div>
      {config.statsPosition === 'below-map' && statsPanel}
    </div>
    </main>
  );
};

export default ObsOverlay;
