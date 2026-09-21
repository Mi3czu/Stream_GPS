import React, { useState } from 'react';
import axios from 'axios';
import { Link, useSearchParams } from 'react-router-dom';
import ThemeToggle from './theme-toggle.jsx';

export const RequestPasswordReset = () => {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault(); setError(null); setMessage(null);
    try {
      const response = await axios.post('/api/password-reset/request', { email });
      setMessage(response.data.message);
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  return <div className="auth-page"><ThemeToggle compact /><div className="auth-card"><h1>Reset password</h1><p>Enter the email address associated with your account.</p><form onSubmit={submit}><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" autoComplete="email" required /><button type="submit">Send reset link</button></form>{message && <p className="auth-message auth-message--success">{message}</p>}{error && <p className="auth-message auth-message--error">{error}</p>}<p><Link to="/login">Back to login</Link></p></div></div>;
};

const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const token = searchParams.get('token') || '';

  const submit = async (event) => {
    event.preventDefault(); setError(null); setMessage(null);
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    try {
      const response = await axios.post('/api/password-reset/confirm', { token, password });
      setMessage(response.data.message); setPassword(''); setConfirmPassword('');
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message); }
  };

  return <div className="auth-page"><ThemeToggle compact /><div className="auth-card"><h1>Choose a new password</h1>{!token ? <><p className="auth-message auth-message--error">This reset link is incomplete.</p><p><Link to="/forgot-password">Request a new link</Link></p></> : <><form onSubmit={submit}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New password (at least 12 characters)" autoComplete="new-password" minLength={12} required /><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat new password" autoComplete="new-password" minLength={12} required /><button type="submit">Update password</button></form>{message && <p className="auth-message auth-message--success">{message}</p>}{error && <p className="auth-message auth-message--error">{error}</p>}<p><Link to="/login">Back to login</Link></p></>}</div></div>;
};

export default ResetPassword;
