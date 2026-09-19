// src/backend/api/user.route.js
const express = require('express');
const router = express.Router();
const User = require('./user');

router.get('/', (req, res) => {
  User.find().then(users => {
    res.json(users);
  }).catch(err => {
    res.status(500).json({ message: 'Błąd pobierania użytkowników' });
  });
});

router.post('/', (req, res) => {
  const user = new User(req.body);
  user.save().then(() => {
    res.json(user);
  }).catch(err => {
    res.status(500).json({ message: 'Błąd tworzenia użytkownika' });
  });
});
module.exports = router;