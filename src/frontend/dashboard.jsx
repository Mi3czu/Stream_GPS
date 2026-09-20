import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';

const Dashboard = () => {
  const navigate = useNavigate();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    axios.get('/api/v1/devices', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setDevices(response.data.devices))
      .catch((requestError) => {
        if (requestError.response?.status === 401) {
          sessionStorage.removeItem('accessToken');
          navigate('/login', { replace: true });
          return;
        }
        setError(requestError.response?.data?.message || requestError.message);
      });
  }, [navigate]);

  const onlineDevices = devices.filter((device) => (
    device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 120_000
  )).length;

  const handleLogout = () => {
    sessionStorage.removeItem('accessToken');
    navigate('/login');
  };

  return (
    <main>
      <h1>Stream GPS</h1>
      <p>Devices: {devices.length}</p>
      <p>Online in the last two minutes: {onlineDevices}</p>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <p><Link to="/devices">Manage devices</Link></p>
      <h2>Last known positions</h2>
      <ul>
        {devices.map((device) => (
          <li key={device.id}>
            <Link to={`/devices/${encodeURIComponent(device.device_id)}`}>
              {device.name}
            </Link>
            {' — '}
            {device.last_latitude === null
              ? 'No GPS position received yet'
              : `${device.last_latitude}, ${device.last_longitude} — ${device.last_speed ?? 0} km/h`}
          </li>
        ))}
        {!devices.length && <li>No devices registered yet.</li>}
      </ul>
      <button onClick={handleLogout}>Logout</button>
    </main>
  );
};

export default Dashboard;
