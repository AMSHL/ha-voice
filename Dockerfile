ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21
FROM ${BUILD_FROM}
ENV PYTHONUNBUFFERED=1
RUN apk add --no-cache python3 py3-aiohttp py3-pip py3-numpy py3-onnxruntime openssl curl \
 && pip3 install --no-cache-dir --break-system-packages "wyoming>=1.5.4,<2"
COPY spk.sha256 /tmp/spk.sha256
RUN curl -fsSL -o /opt/spk.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx \
 && echo "$(cat /tmp/spk.sha256)  /opt/spk.onnx" | sha256sum -c - \
 && python3 -c 'import numpy, onnxruntime'
COPY run.sh /run.sh
RUN chmod a+x /run.sh
COPY server/ /opt/voice/server/
RUN mv /opt/spk.onnx /opt/voice/spk.onnx
CMD [ "/run.sh" ]
