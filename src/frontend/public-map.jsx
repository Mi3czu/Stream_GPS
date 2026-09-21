import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import GpsMap from './gps-map.jsx';
import ThemeToggle from './theme-toggle.jsx';

const PublicMap = () => {
  const { shareId } = useParams();
  const [device, setDevice] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    let stream;
    let retryTimer;
    const connect = () => {
      if (cancelled) return;
      setState((current) => current === 'disabled' ? 'reconnecting' : current);
      stream = new EventSource(`/api/v1/public-maps/${encodeURIComponent(shareId)}/stream`);
      stream.addEventListener('ready', (event) => {
        if (cancelled) return;
        setDevice(JSON.parse(event.data).device); setState('available');
      });
      stream.addEventListener('position', (event) => {
        if (cancelled) return;
        setDevice(JSON.parse(event.data).device); setState('available');
      });
      stream.addEventListener('disabled', () => {
        if (cancelled) return;
        stream?.close(); setDevice(null); setState('disabled');
        retryTimer = window.setTimeout(connect, 10_000);
      });
      stream.onerror = () => {
        if (!cancelled && state !== 'disabled') setState('reconnecting');
      };
    };
    connect();
    return () => { cancelled = true; stream?.close(); window.clearTimeout(retryTimer); };
  }, [shareId]);

  const position = device?.latitude == null ? [] : [device];
  return <main className="public-map-page">
    <ThemeToggle compact />
    <header className="public-map-page__header"><div><span className="brand__mark">●</span><strong> Stream GPS</strong></div>{device && <span className={`status-pill ${state === 'available' ? 'status-pill--online' : 'status-pill--offline'}`}>{state === 'available' ? 'live' : state}</span>}</header>
    {device ? <>
      <div><h1>{device.name}</h1><p>Live location shared by the broadcaster</p></div>
      <section className="public-map-page__map"><GpsMap positions={position} connectPoints={false} zoomConfig={{ autoZoom: true, minSpeed: 0, maxSpeed: 120, maxZoom: 16, minZoom: 10 }} /></section>
      <section className="public-map-page__stats"><span>Speed<strong>{device.speed ?? '—'} km/h</strong></span><span>Heading<strong>{device.heading ?? '—'}°</strong></span><span>Last update<strong>{device.recorded_at ? new Date(device.recorded_at).toLocaleString() : 'Waiting for GPS'}</strong></span></section>
    </> : <section className="public-map-page__unavailable"><h1>{state === 'loading' ? 'Loading map…' : 'Location sharing is off'}</h1><p>{state === 'disabled' ? 'The broadcaster is not sharing their position right now.' : 'Trying to reconnect…'}</p></section>}
  </main>;
};

export default PublicMap;
