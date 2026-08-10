FROM node:22-bookworm-slim
WORKDIR /app
# fontconfig để librsvg (trong sharp) tìm được bộ font đi kèm ở public/fonts.
# Font chữ dùng khi render nằm trong repo chứ không cài từ hệ thống — xem src/fonts.js.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates fontconfig && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data/assets
EXPOSE 8787
CMD ["node", "--env-file-if-exists=.env", "src/http-server.js"]
