# Runs the Vite dev server (the chosen interim runtime). Client-only React app;
# there are no server routes, so the dev server just serves the SPA over HMR.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5180
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5180"]
