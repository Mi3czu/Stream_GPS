FROM node:24-alpine

WORKDIR /app

COPY src/backend/package*.json ./
RUN npm ci --omit=dev

COPY src/backend ./
COPY database/migrations /app/migrations

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
