ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23
FROM ${BUILD_FROM}
ENV PYTHONUNBUFFERED=1
RUN apk add --no-cache python3 py3-aiohttp py3-pip py3-numpy py3-onnxruntime openssl curl \
 && pip3 install --no-cache-dir --break-system-packages "wyoming>=1.5.4,<2"
COPY spk.sha256 /tmp/spk.sha256
# Хэш сверяется, только если в spk.sha256 записаны 64 hex-символа; иначе печатается в лог
# сборки, чтобы его можно было вписать. Модель меньше 1 МБ = страница ошибки, сборка падает.
RUN curl -fsSL -o /opt/spk.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx \
 && H="$(tr -d ' \r\n' </tmp/spk.sha256)" \
 && if echo "$H" | grep -Eq '^[0-9a-f]{64}$'; then echo "$H  /opt/spk.onnx" | sha256sum -c -; \
    else echo "VOICE spk.sha256 не заполнен; модель: $(sha256sum /opt/spk.onnx)"; fi \
 && test "$(stat -c %s /opt/spk.onnx)" -gt 1000000 \
 && python3 -c 'import numpy, onnxruntime; print("VOICE onnxruntime", onnxruntime.__version__)'
COPY run.sh /run.sh
RUN chmod a+x /run.sh
COPY server/ /opt/voice/server/
RUN mv /opt/spk.onnx /opt/voice/spk.onnx
CMD [ "/run.sh" ]
