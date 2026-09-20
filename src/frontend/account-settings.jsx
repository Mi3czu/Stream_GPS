import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';

const AccountSettings = () => {
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [retentionDays, setRetentionDays] = useState('forever');

  const token = sessionStorage.getItem('accessToken');
  const headers = { Authorization: `Bearer ${token}` };

  const handleUnauthorized = useCallback((requestError) => {
    if (requestError.response?.status !== 401) return false;
    sessionStorage.removeItem('accessToken');
    navigate('/login', { replace: true });
    return true;
  }, [navigate]);

  const loadAccount = useCallback(async () => {
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }
    try {
      const [accountResponse, sessionsResponse] = await Promise.all([
        axios.get('/api/me', { headers }),
        axios.get('/api/v1/account/sessions', { headers })
      ]);
      setAccount(accountResponse.data.user);
      setRetentionDays(accountResponse.data.user.retention_days ?? 'forever');
      setSessions(sessionsResponse.data.sessions);
    } catch (requestError) {
      if (!handleUnauthorized(requestError)) {
        setError(requestError.response?.data?.message || requestError.message);
      }
    }
  }, [handleUnauthorized, navigate, token]);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  const changePassword = async (event) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    try {
      const response = await axios.patch('/api/me/password', {
        current_password: currentPassword,
        new_password: newPassword
      }, { headers });
      setMessage(response.data.message);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await loadAccount();
    } catch (requestError) {
      if (!handleUnauthorized(requestError)) {
        setError(requestError.response?.data?.message || requestError.message);
      }
    }
  };

  const revokeOtherSessions = async () => {
    setError(null);
    setMessage(null);
    try {
      const response = await axios.post('/api/v1/account/sessions/revoke-others', {}, { headers });
      setMessage(`${response.data.message}: ${response.data.revoked_sessions}`);
      await loadAccount();
    } catch (requestError) {
      if (!handleUnauthorized(requestError)) {
        setError(requestError.response?.data?.message || requestError.message);
      }
    }
  };

  const saveRetention = async (event) => {
    event.preventDefault(); setError(null); setMessage(null);
    try {
      const value = retentionDays === 'forever' ? null : Number(retentionDays);
      const response = await axios.patch('/api/me/privacy', { retention_days: value }, { headers });
      setMessage(response.data.message);
    } catch (requestError) {
      if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message);
    }
  };

  return (
    <main>
      <Link className="back-link" to="/dashboard"><span aria-hidden="true">←</span> Back to dashboard</Link>
      <h1>Account settings</h1>

      {error && <p style={{ color: 'red' }}>{error}</p>}
      {message && <p style={{ color: 'green' }}>{message}</p>}

      {account && (
        <section>
          <h2>Profile</h2>
          <p>Username: <strong>{account.username}</strong></p>
          <p>Email: <strong>{account.email}</strong></p>
        </section>
      )}

      <section>
        <h2>Change password</h2>
        <form onSubmit={changePassword}>
          <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Current password" autoComplete="current-password" required />
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="New password (at least 12 characters)" autoComplete="new-password" minLength={12} required />
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat new password" autoComplete="new-password" minLength={12} required />
          <button type="submit">Change password</button>
        </form>
      </section>

      <section>
        <h2>GPS data privacy</h2>
        <p>Choose how long GPS history from all your devices is stored. Shorter retention reduces privacy risk and database usage.</p>
        <form onSubmit={saveRetention}>
          <select value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)}>
            <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="forever">Keep until I delete it</option>
          </select>
          <button type="submit">Save retention</button>
        </form>
      </section>

      <section>
        <h2>Active sessions</h2>
        <p>Changing your password automatically signs out all other sessions.</p>
        <button type="button" onClick={revokeOtherSessions}>Sign out other devices</button>
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              {session.current ? <strong>This device</strong> : 'Other device'}
              {' - signed in '}{new Date(session.created_at).toLocaleString()}
              {' - expires '}{new Date(session.expires_at).toLocaleString()}
              {session.ip_address && ` - IP ${session.ip_address}`}
            </li>
          ))}
          {!sessions.length && <li>No active sessions found.</li>}
        </ul>
      </section>
    </main>
  );
};

export default AccountSettings;
