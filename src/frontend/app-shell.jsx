import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import ThemeToggle from './theme-toggle.jsx';

const AppShell = () => {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [username, setUsername] = useState('');

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }
    axios.get('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setUsername(response.data.user.username))
      .catch((error) => {
        if (error.response?.status === 401) {
          sessionStorage.removeItem('accessToken');
          navigate('/login', { replace: true });
        }
      });
  }, [navigate]);

  const logout = async () => {
    const token = sessionStorage.getItem('accessToken');
    try {
      if (token) await axios.post('/api/logout', {}, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Always clear the browser session, even if the server session has expired.
    }
    sessionStorage.removeItem('accessToken');
    navigate('/login');
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <button className="icon-button" type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Toggle navigation">☰</button>
        <span className="mobile-header__brand">Stream GPS</span>
      </header>
      {menuOpen && <button className="nav-backdrop" type="button" onClick={closeMenu} aria-label="Close navigation" />}
      <aside className={`sidebar ${menuOpen ? 'sidebar--open' : ''}`}>
        <div className="brand">
          <span className="brand__mark">●</span>
          <div><strong>Stream GPS</strong><small>Live tracking</small></div>
        </div>
        <nav className="sidebar__nav" aria-label="Main navigation">
          <NavLink to="/dashboard" onClick={closeMenu}>Dashboard</NavLink>
          <NavLink to="/devices" onClick={closeMenu}>Devices</NavLink>
          <NavLink to="/account" onClick={closeMenu}>Account</NavLink>
        </nav>
        <div className="sidebar__footer">
          <ThemeToggle />
          {username && <span className="sidebar__user">Signed in as <strong>{username}</strong></span>}
          <button className="button button--ghost" type="button" onClick={logout}>Log out</button>
        </div>
      </aside>
      <div className="app-content"><Outlet /></div>
    </div>
  );
};

export default AppShell;
