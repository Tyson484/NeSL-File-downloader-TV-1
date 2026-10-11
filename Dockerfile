FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install Chromium, ChromeDriver, and required dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-driver \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Explicit browser and driver locations.
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver
ENV CHROME_HEADLESS=true

WORKDIR /app

# Install root dependencies.
COPY package*.json ./
RUN npm install

# Install backend dependencies.
COPY backend/package*.json ./backend/
RUN npm install --prefix backend

# Install frontend dependencies.
COPY frontend/package*.json ./frontend/
RUN npm install --prefix frontend

# Copy the application source.
COPY . .

# Build the frontend.
RUN npm run build

# Configure the backend.
ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0

EXPOSE 10000

CMD ["npm", "start"]