# Stream GPS

Stream GPS is a full-stack JavaScript project with a React/Vite frontend and an Express/MongoDB backend.

## Current features

- React pages for home, login, and registration
- Client-side routing with React Router
- Express API endpoints for user registration and login
- MongoDB user persistence with unique usernames and emails
- Password hashing with bcryptjs
- Vite development proxy from the frontend to the API

## Project layout

```
src/
  backend/   Express API and MongoDB setup
  frontend/  React/Vite application
```

## Requirements

- Node.js 22.12 or later
- A local MongoDB server running on `127.0.0.1:27017`

## Run locally

Install and start the backend:

```powershell
cd src/backend
npm install
npm start
```

The API runs at `http://localhost:3000`.

In a second terminal, install and start the frontend:

```powershell
cd src/frontend
npm install
npm run dev
```

Open `http://localhost:5173` in the browser. The login and registration pages are available at `/login` and `/register`.

## API endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/register` | Create a user with `username`, `email`, and `password` |
| `POST` | `/api/login` | Validate `username` and `password` |

Passwords are stored as bcrypt hashes, never as plaintext.

## Development note

The Vite proxy forwards frontend `/api` requests to the Express server on port 3000. The browser pages are served by Vite on port 5173; API endpoints are not browser pages and should be called with `POST` requests from the forms.
