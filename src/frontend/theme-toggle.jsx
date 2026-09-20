import React, { useState } from 'react';

const getCurrentTheme = () => document.documentElement.dataset.theme || 'light';

const ThemeToggle = ({ compact = false }) => {
  const [theme, setTheme] = useState(getCurrentTheme);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('streamGpsTheme', nextTheme);
    setTheme(nextTheme);
  };

  return (
    <button
      className={`theme-toggle ${compact ? 'theme-toggle--compact' : ''}`}
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
      {!compact && <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>}
    </button>
  );
};

export default ThemeToggle;
