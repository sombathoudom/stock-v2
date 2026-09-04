# =========================
# Stage 1: Dependencies
# =========================
FROM node:20-alpine AS deps

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci && npm cache clean --force


# =========================
# Stage 2: Build
# =========================
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY . .

ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_CONVEX_SITE_URL
ARG APP_URL
ARG CONVEX_DEPLOY_KEY

ENV NEXT_PUBLIC_CONVEX_URL=${NEXT_PUBLIC_CONVEX_URL}
ENV NEXT_PUBLIC_CONVEX_SITE_URL=${NEXT_PUBLIC_CONVEX_SITE_URL}
ENV APP_URL=${APP_URL}

ENV NEXT_TELEMETRY_DISABLED=1

# When CONVEX_DEPLOY_KEY is provided, `build:convex` pushes the convex/
# functions to the Convex backend and then runs `next build` with the correct
# NEXT_PUBLIC_CONVEX_URL. Without a key, fall back to a plain frontend build.
# This ARG lives only in the builder stage — it is never copied into the
# final runtime image below.
RUN if [ -n "${CONVEX_DEPLOY_KEY}" ]; then \
      CONVEX_DEPLOY_KEY="${CONVEX_DEPLOY_KEY}" npm run build:convex; \
    else \
      npm run build; \
    fi


# =========================
# Stage 3: Production
# =========================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs


COPY --from=builder /app/public ./public

COPY --from=builder /app/.next/standalone ./

COPY --from=builder /app/.next/static ./.next/static


RUN chown -R nextjs:nodejs /app


USER nextjs


# Next.js internal container port
EXPOSE 3000


ENV PORT=3000
ENV HOSTNAME=0.0.0.0


HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000 || exit 1


CMD ["node", "server.js"]
