import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate, useParams } from 'react-router-dom';
import GpsMap from './gps-map.jsx';

const DeviceDetails = () => {
  const { deviceId } = useParams();
  const navigate = useNavigate();
  const [device, setDevice] = useState(null);
  const [positions, setPositions] = useState([]);
  const [rangeHours, setRangeHours] = useState('24');
  const [refreshSeconds, setRefreshSeconds] = useState('15');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadDevice = useCallback(async ({ showLoading = false } = {}) => {
    const token = sessionStorage.getItem('accessToken');
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    if (showLoading) setLoading(true);
    const params = new URLSearchParams({ limit: '1000' });
    if (rangeHours !== 'all') {
      params.set('from', new Date(Date.now() - Number(rangeHours) * 60 * 60 * 1000).toISOString());
    }

    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [deviceResponse, historyResponse] = await Promise.all([
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}`, { headers }),
        axios.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/history?${params.toString()}`, { headers })
      ]);
      setDevice(deviceResponse.data.device);
      setPositions(historyResponse.data.positions);
      setLastUpdated(new Date());
      setError(null);
    } catch (requestError) {
      if (requestError.response?.status === 401) {
        sessionStorage.removeItem('accessToken');
        navigate('/login', { replace: true });
        return;
      }
      setError(requestError.response?.data?.message || requestError.message);
    } finally {
      setLoading(false);
    }
  }, [deviceId, navigate, rangeHours]);

  useEffect(() => {
    loadDevice({ showLoading: true });
    if (refreshSeconds === 'off') return undefined;

    const refreshTimer = window.setInterval(
      () => loadDevice(),
      Number(refreshSeconds) * 1000
    );
    return () => window.clearInterval(refreshTimer);
  }, [loadDevice, refreshSeconds]);

  return (
    <main>
      <p><Link to="/devices">Back to devices</Link></p>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {loading && !device && <p>Loading device...</p>}

      {device && (
        <>
          <h1>{device.name}</h1>
          <p>Device ID: <code>{device.device_id}</code></p>
          <p>Status: {device.status}</p>
          <p>Last seen: {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'Never'}</p>

          <h2>Last position</h2>
          {device.last_latitude === null ? <p>No GPS position received yet.</p> : (
            <ul>
              <li>Latitude: {device.last_latitude}</li>
              <li>Longitude: {device.last_longitude}</li>
              <li>Altitude: {device.last_altitude ?? 'Not reported'} m</li>
              <li>Speed: {device.last_speed ?? 'Not reported'} km/h</li>
              <li>Heading: {device.last_heading ?? 'Not reported'} degrees</li>
              <li>Accuracy: {device.last_accuracy ?? 'Not reported'} m</li>
              <li>Satellites: {device.last_satellites ?? 'Not reported'}</li>
              <li>GPS time: {device.last_recorded_at ? new Date(device.last_recorded_at).toLocaleString() : 'Not reported'}</li>
            </ul>
          )}

          <h2>GPS history</h2>
          <label htmlFor="history-range">Period: </label>
          <select id="history-range" value={rangeHours} onChange={(event) => setRangeHours(event.target.value)}>
            <option value="1">Last hour</option>
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
            <option value="168">Last 7 days</option>
            <option value="all">All saved points</option>
          </select>
          <button type="button" onClick={() => loadDevice({ showLoading: true })} disabled={loading}>
            Refresh now
          </button>
          <label htmlFor="refresh-frequency"> Auto-refresh: </label>
          <select
            id="refresh-frequency"
            value={refreshSeconds}
            onChange={(event) => setRefreshSeconds(event.target.value)}
          >
            <option value="5">Every 5 seconds</option>
            <option value="15">Every 15 seconds</option>
            <option value="30">Every 30 seconds</option>
            <option value="60">Every 60 seconds</option>
            <option value="off">Off</option>
          </select>
          <p>
            Showing {positions.length} points. {refreshSeconds === 'off'
              ? 'Automatic refresh is off.'
              : `Automatic refresh: every ${refreshSeconds} seconds.`}
            {lastUpdated && ` Last update: ${lastUpdated.toLocaleTimeString()}.`}
          </p>
          <GpsMap positions={positions} />
          <ol>
            {positions.slice().reverse().map((position, index) => (
              <li key={`${position.recorded_at}-${position.latitude}-${position.longitude}-${index}`}>
                {new Date(position.recorded_at).toLocaleString()}: {position.latitude}, {position.longitude}
                {position.speed !== null && ` - ${position.speed} km/h`}
              </li>
            ))}
            {!positions.length && <li>No GPS history in this period.</li>}
          </ol>
        </>
      )}
    </main>
  );
};

export default DeviceDetails;
