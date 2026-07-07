FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN npm ci --ignore-scripts --workspace shared --workspace frontend
COPY shared shared
COPY frontend frontend
RUN npm run build -w frontend

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
