import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';

const AuditLog = () => {
  const navigate = useNavigate();
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }
    axios.get('/api/v1/audit-logs?limit=200', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setLogs(response.data.logs))
      .catch((requestError) => {
        if (requestError.response?.status === 401) {
          sessionStorage.removeItem('accessToken');
          navigate('/login', { replace: true });
          return;
        }
        setError(requestError.response?.data?.message || requestError.message);
      });
  }, [navigate]);

  return (
    <main>
      <Link className="back-link" to="/dashboard"><span aria-hidden="true">←</span> Back to dashboard</Link>
      <h1>Security audit log</h1>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <table>
        <thead>
          <tr><th>Time</th><th>Account</th><th>Action</th><th>Target</th><th>IP address</th></tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td>{new Date(log.created_at).toLocaleString()}</td>
              <td>{log.username || 'System'}</td>
              <td>{log.action}</td>
              <td>{[log.target_type, log.target_id].filter(Boolean).join(': ') || '-'}</td>
              <td>{log.ip_address || '-'}</td>
            </tr>
          ))}
          {!logs.length && <tr><td colSpan="5">No audited operations yet.</td></tr>}
        </tbody>
      </table>
    </main>
  );
};

export default AuditLog;
