FROM node:24-alpine
WORKDIR /app
COPY . .
ENV PORT=6969
EXPOSE 6969
CMD ["node", "server.js"]
