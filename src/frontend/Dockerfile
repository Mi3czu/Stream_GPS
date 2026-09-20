FROM node:24-alpine AS build

WORKDIR /app

COPY src/frontend/package*.json ./
RUN npm ci

COPY src/frontend ./
RUN npm run build

FROM caddy:2.10-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /usr/share/caddy
