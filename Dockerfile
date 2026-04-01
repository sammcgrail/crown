FROM node:20-alpine

RUN apk add --no-cache sqlite

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 20005

CMD ["node", "server.js"]
