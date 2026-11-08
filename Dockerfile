FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run check && npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY web ./web
COPY tasker ./tasker
COPY --from=build /app/dist/scripts ./validation/scripts
COPY --from=build /app/dist/src ./validation/src
RUN mkdir -p /data /actual-cache && chown node:node /data /actual-cache
USER node
EXPOSE 3000
ENTRYPOINT ["tini","--"]
CMD ["node","dist/src/main.js"]
