import { Link, Route, Routes } from 'react-router-dom';
import Login from './login.jsx';
import Register from './register.jsx';

function Home() {
  return (
    <main>
      <h1>Stream GPS</h1>

      <p>
        <Link to="/login">Login</Link>
      </p>

      <p>
        <Link to="/register">Register</Link>
      </p>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
    </Routes>
  );
}