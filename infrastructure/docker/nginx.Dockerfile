# infrastructure/docker/nginx.Dockerfile
# Bakes nginx.conf + routes + proxy_params directly into the image.
# Friend's machine needs NO repo files — just the compose file and .env.

FROM nginx:1.25-alpine

# Remove default config
RUN rm -rf /etc/nginx/conf.d/*

# Copy all nginx config into the image
COPY infrastructure/nginx/nginx.conf          /etc/nginx/nginx.conf
COPY infrastructure/nginx/proxy_params        /etc/nginx/proxy_params
COPY infrastructure/nginx/sites-available/    /etc/nginx/sites-available/

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost/nginx-health || exit 1
