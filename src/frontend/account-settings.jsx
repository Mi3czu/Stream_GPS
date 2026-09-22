import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

const AccountSettings = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [account, setAccount] = useState(null); const [sessions, setSessions] = useState([]);
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState(null); const [error, setError] = useState(null); const [retentionDays, setRetentionDays] = useState('forever');
  const [chatIntegrations, setChatIntegrations] = useState([]);
  const [chatAdminForms, setChatAdminForms] = useState({ kick: { platform_user_id: '', username: '' }, twitch: { platform_user_id: '', username: '' } });
  const token = sessionStorage.getItem('accessToken'); const headers = { Authorization: `Bearer ${token}` };

  const handleUnauthorized = useCallback((requestError) => {
    if (requestError.response?.status !== 401) return false;
    sessionStorage.removeItem('accessToken'); navigate('/login', { replace: true }); return true;
  }, [navigate]);
  const loadAccount = useCallback(async () => {
    if (!token) { navigate('/login', { replace: true }); return; }
    try {
      const [accountResponse, sessionsResponse, chatResponse] = await Promise.all([axios.get('/api/me', { headers }), axios.get('/api/v1/account/sessions', { headers }), axios.get('/api/v1/chat/integrations', { headers })]);
      setAccount(accountResponse.data.user); setRetentionDays(accountResponse.data.user.retention_days ?? 'forever'); setSessions(sessionsResponse.data.sessions); setChatIntegrations(chatResponse.data.integrations || []);
    } catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  }, [handleUnauthorized, navigate, token]);
  useEffect(() => { loadAccount(); }, [loadAccount]);

  const changePassword = async (event) => {
    event.preventDefault(); setError(null); setMessage(null);
    if (newPassword !== confirmPassword) { setError('New passwords do not match'); return; }
    try { const response = await axios.patch('/api/me/password', { current_password: currentPassword, new_password: newPassword }, { headers }); setMessage(response.data.message); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); await loadAccount(); }
    catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  };
  const saveRetention = async (event) => {
    event.preventDefault(); setError(null); setMessage(null);
    try { const response = await axios.patch('/api/me/privacy', { retention_days: retentionDays === 'forever' ? null : Number(retentionDays) }, { headers }); setMessage(response.data.message); }
    catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  };
  const revokeOtherSessions = async () => {
    try { const response = await axios.post('/api/v1/account/sessions/revoke-others', {}, { headers }); setMessage(`${response.data.message}: ${response.data.revoked_sessions}`); await loadAccount(); }
    catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  };
  const disconnectChat = async (platform) => {
    if (!window.confirm(`Disconnect ${platform}? Stored chat credentials and command permissions will be removed. GPS devices and overlays are not affected.`)) return;
    try { await axios.delete(`/api/v1/chat/integrations/${platform}`, { headers }); setMessage(`${platform} chat integration disconnected.`); await loadAccount(); }
    catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  };
  const saveChatAdmin = async (platform) => {
    try { await axios.post(`/api/v1/chat/integrations/${platform}/admins`, chatAdminForms[platform], { headers }); setChatAdminForms((current) => ({ ...current, [platform]: { platform_user_id: '', username: '' } })); setMessage(`Trusted ${platform} admin saved.`); await loadAccount(); }
    catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  };
  const removeChatAdmin = async (platform, adminId) => {
    try { await axios.delete(`/api/v1/chat/integrations/${platform}/admins/${adminId}`, { headers }); await loadAccount(); }
    catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  };
  const connectTwitch = async () => {
    setError(null); setMessage(null);
    try {
      const response = await axios.post('/api/v1/chat/twitch/connect', {}, { headers });
      window.location.assign(response.data.authorization_url);
    } catch (requestError) { if (!handleUnauthorized(requestError)) setError(requestError.response?.data?.message || requestError.message); }
  };

  return <main className="settings-page">
    <header className="page-header settings-page__header"><div><Link className="back-link" to="/dashboard"><span aria-hidden="true">←</span> Back to dashboard</Link><h1>Account settings</h1><p>Profile, security, privacy and streaming integrations in one place.</p></div></header>
    {error && <div className="alert alert--error">{error}</div>}{message && <div className="alert alert--success">{message}</div>}
    {searchParams.get('chat') === 'twitch-connected' && <div className="alert alert--success">Twitch account connected successfully.</div>}
    {searchParams.get('chat') === 'twitch-error' && <div className="alert alert--error">Twitch connection failed. Check the server configuration and try again.</div>}
    <div className="settings-grid">
      <section className="panel settings-panel"><div className="panel__header"><div><h2>Profile</h2><p className="panel__hint">Your account identity keeps devices and overlays private.</p></div></div>{account ? <dl className="settings-details"><div><dt>Username</dt><dd>{account.username}</dd></div><div><dt>Email</dt><dd>{account.email}</dd></div></dl> : <p className="panel__hint">Loading profile…</p>}</section>
      <section className="panel settings-panel"><div className="panel__header"><div><h2>GPS data privacy</h2><p className="panel__hint">Choose how long history from all devices is stored.</p></div></div><form className="settings-form" onSubmit={saveRetention}><label>History retention<select value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="forever">Keep until I delete it</option></select></label><button type="submit">Save retention</button></form></section>
      <section className="panel settings-panel settings-panel--wide"><div className="panel__header"><div><h2>Change password</h2><p className="panel__hint">A new password signs out every other active session.</p></div></div><form className="settings-form settings-form--password" onSubmit={changePassword}><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Current password" autoComplete="current-password" required /><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="New password (at least 12 characters)" autoComplete="new-password" minLength={12} required /><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat new password" autoComplete="new-password" minLength={12} required /><button type="submit">Change password</button></form></section>
    </div>
    <section className="panel settings-panel"><div className="panel__header"><div><h2>Chat integrations</h2><p className="panel__hint">Optional controls for location sharing and OBS overlay visibility. Nothing is connected or enabled by default.</p></div></div><div className="device-list">{chatIntegrations.map(({ platform, configured, callback_path: callbackPath, integration }) => <article className="device-card" key={platform}><div className="device-card__top"><strong>{platform === 'kick' ? 'Kick' : 'Twitch'}</strong><span className={`status-pill ${integration?.enabled ? 'status-pill--online' : 'status-pill--offline'}`}>{integration?.enabled ? 'connected' : 'not connected'}</span></div>{integration?.channel_id ? <><p className="panel__hint">Channel: {integration.channel_name || integration.channel_id}. Account authorization is saved; chat command delivery will be enabled in the next setup step.</p><button className="button--danger" type="button" onClick={() => disconnectChat(platform)}>Disconnect and remove</button></> : configured && platform === 'twitch' ? <><p className="panel__hint">Connect your Twitch account to authorize Stream GPS for chat integration.</p><button type="button" onClick={connectTwitch}>Connect Twitch</button></> : configured ? <p className="panel__hint">This platform is configured. OAuth connection UI will be enabled soon.</p> : <p className="panel__hint">Not connected yet. Add server OAuth credentials and a public HTTPS address before enabling live chat control.</p>}<div className="chat-admins"><strong>Trusted admins</strong><p className="panel__hint">Use a stable platform user ID, not only a nickname.</p><div className="chat-admin-form"><input value={chatAdminForms[platform].platform_user_id} onChange={(event) => setChatAdminForms((current) => ({ ...current, [platform]: { ...current[platform], platform_user_id: event.target.value } }))} placeholder="Platform user ID" /><input value={chatAdminForms[platform].username} onChange={(event) => setChatAdminForms((current) => ({ ...current, [platform]: { ...current[platform], username: event.target.value } }))} placeholder="Nickname (optional)" /><button type="button" onClick={() => saveChatAdmin(platform)}>Add admin</button></div><ul>{integration?.authorized_users?.map((admin) => <li key={admin.id}><code>{admin.platform_user_id}</code>{admin.username ? ` — ${admin.username}` : ''}<button className="button--secondary button--small" type="button" onClick={() => removeChatAdmin(platform, admin.id)}>Remove</button></li>) || <li>No trusted admins added.</li>}</ul></div><small>Callback path: <code>{callbackPath}</code></small></article>)}</div></section>
    <section className="panel settings-panel"><div className="panel__header"><div><h2>Active sessions</h2><p className="panel__hint">Review active browsers and sign out devices you no longer use.</p></div><button type="button" className="button--secondary" onClick={revokeOtherSessions}>Sign out other devices</button></div><ul className="session-list">{sessions.map((session) => <li key={session.id}><div><strong>{session.current ? 'This device' : 'Other device'}</strong><span>Signed in {new Date(session.created_at).toLocaleString()}</span></div><small>Expires {new Date(session.expires_at).toLocaleString()}{session.ip_address && ` · IP ${session.ip_address}`}</small></li>)}{!sessions.length && <li>No active sessions found.</li>}</ul></section>
  </main>;
};

export default AccountSettings;
