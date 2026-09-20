import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams, useSearchParams } from 'react-router-dom';
import GpsMap from './gps-map.jsx';
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
        setError(null);
        stream = new EventSource(`/api/v1/overlays/${encodeURIComponent(overlayId)}/stream?key=${encodeURIComponent(key)}`);
        stream.addEventListener('ready', (event) => {
          const payload = JSON.parse(event.data);
          setDevice(payload.device);
          setConfig(payload.config);
        });
        stream.addEventListener('position', (event) => {
          setDevice(JSON.parse(event.data).device);
        });
        stream.addEventListener('config', (event) => {
          setConfig(JSON.parse(event.data).config);
        });
      } catch {
        setError('Overlay is unavailable.');
      }
    };
    load();
    return () => stream?.close();
  }, [overlayId, searchParams]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  if (error) return <main className="obs-overlay"><p>{error}</p></main>;
  if (!device || !config) return <main className="obs-overlay"><p>Loading overlay...</p></main>;
  const position = device.latitude === null ? [] : [{
    latitude: device.latitude,
    longitude: device.longitude,
    speed: device.speed,
    recorded_at: device.recorded_at
  }];
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
  ].filter((item) => item && item[1]);
  const statsPanel = stats.length ? (
    <section className="obs-overlay__stats" style={{ '--stats-text-size': `${config.statsTextSize}px` }}>
      {stats.map(([label, value]) => <span key={label}><strong>{label}</strong> {value}</span>)}
    </section>
  ) : null;

  return (
    <main className={`obs-overlay obs-overlay--${config.textTheme}`} style={{ '--overlay-text-color': config.textColor, '--overlay-font': config.fontFamily }}>
      {config.statsPosition === 'above-map' && statsPanel}
      <div className={`obs-overlay__map obs-overlay__map--${config.mapShape}`} style={{ '--overlay-size': `${config.mapSize}px`, '--overlay-border': config.borderColor }}>
        <GpsMap positions={position} mapTheme={config.mapTheme} size={config.mapSize} zoomConfig={config} zoomControl={false} />
      </div>
      <section className="obs-overlay__info">
        <strong>{device.name}</strong>
        <span>{device.speed ?? 0} km/h</span>
      </section>
      {config.statsPosition === 'below-map' && statsPanel}
    </main>
  );
};

export default ObsOverlay;
