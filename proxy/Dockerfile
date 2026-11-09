FROM node:22-alpine
WORKDIR /app
COPY src ./src
ENV PORT=3000 CHANNELS_FILE=/app/data/channels.json
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "src/index.js"]
