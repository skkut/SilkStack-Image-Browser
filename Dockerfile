FROM node:22-slim

WORKDIR /app

# Install dependencies (keep dev deps so tsx can run TypeScript directly)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Include license in the image for downstream compliance
COPY LICENSE ./LICENSE

# Default entrypoint: CLI (scripts/cli.ts — see docs/CLI-TOOLS.md)
ENTRYPOINT ["npx", "tsx", "scripts/cli.ts"]
CMD ["--help"]
