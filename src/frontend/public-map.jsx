import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import GpsMap from './gps-map.jsx';
import ThemeToggle from './theme-toggle.jsx';

const PublicMap = () => {
  const { shareId } = useParams();
  const [device, setDevice] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await axios.get(`/api/v1/public-maps/${encodeURIComponent(shareId)}`);
        if (!cancelled) { setDevice(response.data.device); setState('available'); }
      } catch (error) {
        if (!cancelled) {
          if (error.response?.status === 404) { setDevice(null); setState('disabled'); }
          else setState('reconnecting');
        }
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
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
