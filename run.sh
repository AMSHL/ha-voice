#!/usr/bin/with-contenv bashio
set -eu
IP="$(bashio::config 'host_ip')"
T=/data/tls
mkdir -p "$T" /data/recordings
# Сертификат один раз (заново при смене host_ip); CA:TRUE нужен для доверия в iOS.
if [ ! -s "$T/cert.pem" ] || [ "$(cat "$T/ip" 2>/dev/null)" != "$IP" ]; then
  printf '%s\n' '[req]' 'distinguished_name=dn' 'x509_extensions=ext' 'prompt=no' \
    '[dn]' "CN=${IP}" 'O=Home Voice' '[ext]' 'basicConstraints=critical,CA:TRUE' \
    'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign' \
    'extendedKeyUsage=serverAuth' "subjectAltName=IP:${IP}" >"$T/openssl.cnf"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -config "$T/openssl.cnf" -keyout "$T/key.pem" -out "$T/cert.pem"
  chmod 600 "$T/key.pem"
  echo "$IP" >"$T/ip"
fi
exec python3 /opt/voice/server/server.py
