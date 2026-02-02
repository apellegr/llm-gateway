FROM node:20-alpine

LABEL org.opencontainers.image.source=https://github.com/apellegr/llm-gateway
LABEL org.opencontainers.image.description="LLM Gateway - Intelligent LLM routing proxy"
LABEL org.opencontainers.image.licenses=MIT

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY index.js ./

# Copy dashboard static files
COPY public/ ./public/

# Create config directory and set permissions
RUN mkdir -p /config && \
    chown -R node:node /app /config

USER node

# Expose ports
EXPOSE 8080 9090

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/debug/health | grep -q '"status":"healthy"' || exit 1

# Start the gateway
CMD ["node", "index.js"]
