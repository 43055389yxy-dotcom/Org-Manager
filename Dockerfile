FROM node:20-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production PORT=3101 TZ=Asia/Shanghai
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public
USER node
EXPOSE 3101
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 CMD wget -qO- http://127.0.0.1:3101/health >/dev/null || exit 1
CMD ["node", "server.js"]
