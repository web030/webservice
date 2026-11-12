FROM node:22-alpine
RUN apk add --no-cache curl ca-certificates
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY install-aylol.js ./
RUN node install-aylol.js && sed -i 's|/(^lyn:|(/^lyn:|g' src/routes/lines.js
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/agents.db
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
