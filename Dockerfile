FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV TZ=Asia/Jakarta

CMD ["node", "index.js"]
