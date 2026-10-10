FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-driver \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver
ENV CHROME_HEADLESS=true

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY backend/package*.json ./backend/
RUN npm install --prefix backend

COPY frontend/package*.json ./frontend/
RUN npm install --prefix frontend

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0

EXPOSE 10000

CMD ["npm", "start"]