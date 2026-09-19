const express = require('express');
const app = express();
const port = 3000;
app.use(express.json());

const usersCollection = db.collection('users');

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  usersCollection.findOne({ username }, (err, user) => {
    if (err) {
      res.status(500).json({ message: 'Error finding user' });
    } else if (!user) {
      res.status(401).json({ message: 'Invalid username or password' });
    } else if (user.password !== password) {
      res.status(401).json({ message: 'Invalid username or password' });
    } else {
      res.json({ message: 'Login successful', username });
    }
  });
});

app.post('/api/register', (req, res) => {
  const { username, password, email } = req.body;
  const existingUser = usersCollection.findOne({ username });
  if (existingUser) {
    res.status(400).json({ message: 'Username already taken' });
  } else {
    const newUser = {
      username,
      password,
      email
    };
    usersCollection.insertOne(newUser, (err, result) => {
      if (err) {
        res.status(500).json({ message: 'Error creating new user' });
      } else {
        res.json({ message: 'User created successfully' });
      }
    });
  }
});

app.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});

