FROM node:22-slim

# openssl: used to hash generated VPS passwords (SHA-512 crypt) before they reach Fly.io
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
USER node

CMD ["node", "src/index.js"]
