FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    fonts-noto \
    fonts-liberation \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Find chromium path and store it
RUN which chromium || which chromium-browser || find / -name "chromium*" -type f 2>/dev/null | head -5

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
