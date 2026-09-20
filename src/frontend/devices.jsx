import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';

const Devices = () => {
  const navigate = useNavigate();
  const [devices, setDevices] = useState([]);
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [issuedKey, setIssuedKey] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const headers = () => ({ Authorization: `Bearer ${sessionStorage.getItem('accessToken')}` });

  const loadDevices = async () => {
    try {
      const response = await axios.get('/api/v1/devices', { headers: headers() });
      setDevices(response.data.devices);
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
  };

  useEffect(() => {
    if (!sessionStorage.getItem('accessToken')) {
      navigate('/login', { replace: true });
      return;
    }
    loadDevices();
  }, [navigate]);

  const createDevice = async (event) => {
    event.preventDefault();
    setError(null);
    setIssuedKey(null);

    try {
      const response = await axios.post('/api/v1/devices', {
        name,
        ...(deviceId.trim() ? { device_id: deviceId.trim() } : {})
      }, { headers: headers() });

      setIssuedKey({
        deviceId: response.data.device.device_id,
        deviceKey: response.data.device_key
      });
      setName('');
      setDeviceId('');
      await loadDevices();
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
    }
  };

  const revokeDevice = async (id) => {
    if (!window.confirm(`Revoke ${id}? It will stop accepting GPS updates.`)) return;
    try {
      await axios.post(`/api/v1/devices/${encodeURIComponent(id)}/revoke`, {}, { headers: headers() });
      await loadDevices();
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
    }
  };

  return (
    <main>
      <h1>Devices</h1>
      <p><Link to="/dashboard">Back to dashboard</Link></p>
      <h2>Add Belabox</h2>
      <form onSubmit={createDevice}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Device name, e.g. Studio van" required />
        <input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="Optional device ID, e.g. belabox_7522" />
        <button type="submit">Create device</button>
      </form>

      {issuedKey && (
        <section style={{ border: '2px solid #b45309', padding: '1rem', marginTop: '1rem' }}>
          <h2>Save these credentials now</h2>
          <p>They are shown only once. Store the key in the Belabox configuration, never in Git.</p>
          <p><strong>DEVICE_ID:</strong> <code>{issuedKey.deviceId}</code></p>
          <p><strong>DEVICE_KEY:</strong> <code>{issuedKey.deviceKey}</code></p>
          <button onClick={() => setIssuedKey(null)}>I saved the key</button>
        </section>
      )}

      {error && <p style={{ color: 'red' }}>{error}</p>}
      <h2>Registered devices</h2>
      {loading ? <p>Loading devices…</p> : (
        <ul>
          {devices.map((device) => (
            <li key={device.id}>
              <strong>{device.name}</strong> — {device.device_id} — {device.status}
              {device.last_seen_at && ` — last seen ${new Date(device.last_seen_at).toLocaleString()}`}
              {device.status === 'active' && <> <button onClick={() => revokeDevice(device.device_id)}>Revoke</button></>}
            </li>
          ))}
          {!devices.length && <li>No devices registered yet.</li>}
        </ul>
      )}
    </main>
  );
};

export default Devices;
