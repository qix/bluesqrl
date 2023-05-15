FROM node:18
WORKDIR /app
COPY package.json yarn.lock /app/
COPY ./build/sqrl /sqrl/
RUN yarn
COPY . /app/
