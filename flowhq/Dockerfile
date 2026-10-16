# FLOW HQ (web app + API in one Node process). Build from the REPOSITORY ROOT so the workflows' shared code is included:
#   docker build -f flowhq/Dockerfile -t flowhq .
FROM node:20-alpine AS build
WORKDIR /app/flowhq
COPY flowhq/package.json flowhq/package-lock.json ./
RUN npm ci
COPY flowhq/ ./
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    FLOWHQ_STATIC_DIR=/app/flowhq/dist/web \
    FLOWHQ_SNIPPETS_DIR=/app/n8n/snippets \
    FLOWHQ_USERS_FILE=/app/flowhq/config/users.json \
    FLOWHQ_WORKSPACES_FILE=/app/flowhq/config/workspaces.json
WORKDIR /app/flowhq
COPY flowhq/package.json flowhq/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p config && chown node:node config
COPY --from=build /app/flowhq/dist ./dist
# the same snippet files the n8n Code nodes run (weekly numbers, phone format, W10 rules): read-only, never edited here
COPY n8n/snippets /app/n8n/snippets
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "dist/server/index.js"]
