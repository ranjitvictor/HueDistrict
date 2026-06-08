FROM nginx:stable-alpine
COPY index.html /usr/share/nginx/html/index.html
COPY checkout.html /usr/share/nginx/html/checkout.html
COPY privacy.html /usr/share/nginx/html/privacy.html
COPY tos.html /usr/share/nginx/html/tos.html
COPY ig-pfp-1080.png /usr/share/nginx/html/ig-pfp-1080.png
COPY nginx.conf /etc/nginx/conf.d/default.conf
CMD sed -i -e "s/\$PORT/$PORT/g" /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'
