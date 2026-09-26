# شركة الوكلاء — صورة الإنتاج (multi-stage)
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/domain/package.json packages/domain/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm -r build && pnpm --filter @agents/server deploy --prod --legacy /out

FROM node:22-alpine
RUN apk add --no-cache tzdata tini
ENV NODE_ENV=production TZ=Asia/Riyadh PORT=8080 WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out ./server
COPY --from=build /repo/apps/web/dist ./web
USER node
WORKDIR /app/server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
