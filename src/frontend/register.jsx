import React, { useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import ThemeToggle from './theme-toggle.jsx';

const Register = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      const response = await axios.post('/api/register', {
        username,
        email,
        password
      });

      setSuccess(response.data.message);
      setUsername('');
      setEmail('');
      setPassword('');
    } catch (error) {
      setError(error.response?.data?.message || error.message);
    }
  };

  return (
    <div className="auth-page">
      <ThemeToggle compact />
      <div className="auth-card">
      <h1>Create your Stream GPS account</h1>
      <p>Your devices, GPS history, keys and overlays will be private to this account.</p>

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Username"
          required
        />

        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email"
          required
        />

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          minLength={12}
          required
        />

        <button type="submit">Register</button>
      </form>

      {error && <p style={{ color: 'red' }}>{error}</p>}
      {success && <p style={{ color: 'green' }}>{success}</p>}
      <p>Already have an account? <Link to="/login">Log in</Link></p>
      </div>
    </div>
  );
};

export default Register;
