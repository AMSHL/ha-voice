ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19
FROM ${BUILD_FROM}
ENV PYTHONUNBUFFERED=1
RUN apk add --no-cache python3 py3-aiohttp py3-pip openssl \
 && pip3 install --no-cache-dir --break-system-packages "wyoming>=1.5.4,<2"
COPY run.sh /run.sh
RUN chmod a+x /run.sh
COPY server/ /opt/voice/server/
CMD [ "/run.sh" ]
