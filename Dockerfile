FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY binding.gyp ./
COPY src/ ./src/

RUN npm install
RUN npx node-gyp rebuild

COPY server.js ./
COPY public/ ./public/

EXPOSE 3001

CMD ["node", "server.js"]
