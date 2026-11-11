FROM node:24-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src/ ./src/

RUN npm install
RUN npm run build

ENV NODE_ENV=production
CMD ["npm", "start"]
