// src/backend/api/user.controller.js
const mongoose = require('../database');
const User = mongoose.model('User');

class UserController {
  async getAllUsers(req, res) {
    const users = await User.find();
    res.json(users);
  }

  async createUser(req, res) {
    const user = new User(req.body);
    await user.save();
    res.json(user);
  }

  async getUserById(req, res) {
    const id = req.params.id;
    const user = await User.findById(id);
    res.json(user);
  }

  async updateUser(req, res) {
    const id = req.params.id;
    const user = await User.findByIdAndUpdate(id, req.body, { new: true });
    res.json(user);
  }

  async deleteUser(req, res) {
    const id = req.params.id;
    await User.findByIdAndRemove(id);
    res.json({ message: 'User deleted successfully' });
  }
}

module.exports = UserController;