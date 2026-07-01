FROM node:22-bookworm-slim

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY server ./server
COPY public ./public

ENV PORT=3000
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 3000

WORKDIR /app/server
CMD ["node", "server.js"]
