# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# node:alpine already ships a `node` user with uid 1000
USER node
EXPOSE 8080
# TRANSPORT is set via ConfigMap (http in k8s, stdio for local dev)
ENTRYPOINT ["node", "dist/index.js"]
