# Dockerfile (Fly.io / Railway / Docker Compose 等で利用可能)
FROM node:22-alpine

WORKDIR /app

# better-sqlite3 のビルドに必要
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# データは永続ボリュームに保存
ENV DB_PATH=/data/tournament.db
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
