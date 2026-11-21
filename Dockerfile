# FoldPass API + site. No npm dependencies, so this is just Node and the source.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    TRUST_PROXY=1

COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY scripts/reproduce.js ./scripts/reproduce.js

EXPOSE 8080
CMD ["node", "server/index.js"]
