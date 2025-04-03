FROM node:18-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY package-lock.json ./
RUN npm install --production

COPY . .

CMD ["node", "index.js"]