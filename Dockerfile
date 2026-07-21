FROM node:20-alpine
WORKDIR /app
RUN mkdir -p /app/data
COPY server.js index.html ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
