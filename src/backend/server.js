const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost/stream-gps', { useNewUrlParser: true, useUnifiedTopology: true });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const User = mongoose.model('User', {
  name: String,
  email: String
});

app.post('/api/users', (req, res) => {
  const user = new User(req.body);
  user.save((err, user) => {
    if (err) {
      res.status(400).send(err);
    } else {
      res.send(user);
    }
  });
});

app.get('/api/users', (req, res) => {
  User.find().then((users) => {
    res.send(users);
  }).catch((err) => {
    res.status(400).send(err);
  });
});

const port = 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});cd