import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import ThemeToggle from './theme-toggle.jsx';

const Login = () => {
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleSubmit = async (event) => {
    event.preventDefault();

    setError(null);
    setSuccess(null);

    try {
      const response = await axios.post('/api/login', {
        username,
        password
      });

      sessionStorage.setItem('accessToken', response.data.token);

      setSuccess(response.data.message);
      setPassword('');

      navigate('/dashboard');
    } catch (requestError) {
      setError(
        requestError.response?.data?.message || requestError.message
      );
    }
  };

  return (
    <div className="auth-page">
      <ThemeToggle compact />
      <div className="auth-card">
      <h1>Login</h1>

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Username"
          required
        />

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          required
        />

        <button type="submit">Login</button>
      </form>

      {error && <p style={{ color: 'red' }}>{error}</p>}
      {success && <p style={{ color: 'green' }}>{success}</p>}
      <p><Link to="/forgot-password">Forgot your password?</Link></p>
      <p>New to Stream GPS? <Link to="/register">Create an account</Link></p>
      </div>
    </div>
  );
};

export default Login;
