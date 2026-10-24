FROM node:22-alpine
WORKDIR /app
COPY server.mjs validation.mjs layouts.mjs template-store.mjs ./
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0
ENV PORT=8787
ENV TEMPLATE_STORE_PATH=/data/layouts.json
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
