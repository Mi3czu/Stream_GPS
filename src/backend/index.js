const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('./database');

const app = express();
const port = 3000;
const User = mongoose.model('User');

app.use(express.json());

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        message: 'Username, email, and password are required'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await User.create({ username, email, passwordHash });

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 11000) {
      return res.status(409).json({
        message: 'Username or email already exists'
      });
    }

    res.status(500).json({ message: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({
        message: 'Invalid username or password'
      });
    }

    res.json({ message: 'Login successful', username: user.username });
  } catch {
    res.status(500).json({ message: 'Login failed' });
  }
});

app.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});