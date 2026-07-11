FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
RUN npm ci --omit=dev --ignore-scripts --workspace shared --workspace backend
COPY shared shared
COPY backend backend
ENV DATA_DIR=/app/data
EXPOSE 3001
CMD ["npm", "run", "start", "-w", "backend"]
