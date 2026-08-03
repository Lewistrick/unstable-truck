# Build stage: compiles both the browser frontend (src/**/*.ts -> dist/) and
# the backend (server/**/*.ts -> server/dist/) with dev dependencies present.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: only production dependencies and compiled output, no
# TypeScript/dev tooling.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY index.html style.css ./

EXPOSE 8003
CMD ["node", "server/dist/index.js"]
