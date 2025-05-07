# Stage 1: build from source
FROM node:20-alpine AS builder
WORKDIR /app

# Install all dependencies
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src ./src
RUN npm run build

# Stage 2: production image
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy built output
COPY --from=builder /app/dist ./dist

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

EXPOSE 8000
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
