FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=5000 \
    DATA_DIR=/app/data

WORKDIR /app

# better-sqlite3 se compila desde fuente en musl: las herramientas de
# construccion se instalan y se eliminan en la misma capa.
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps \
 && npm cache clean --force

COPY . .

RUN mkdir -p /app/data/uploads /app/data/avatars

EXPOSE 5000

CMD ["node", "server.js"]
