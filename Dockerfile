FROM mcr.microsoft.com/playwright/node:18-bullseye

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
