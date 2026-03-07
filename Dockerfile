FROM node:18-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Nginx stage for serving static files
FROM nginx:alpine

# Copy custom nginx conf if needed (optional)
# COPY nginx.conf /etc/nginx/conf.d/default.conf

# Wipe default nginx html and copy dist
RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
