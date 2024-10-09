FROM node:20 AS build

WORKDIR /app

RUN git clone -b current-version https://github.com/Jni75/mineral-app.git

WORKDIR /app/mineral-app

RUN npm install 
RUN npm run build:cli:js

FROM node:20 AS final

WORKDIR /app

COPY --from=build /app/mineral-app/cli/index.js index.js

ENV WALLET=

CMD [ "node", "index.js", "mine" ]