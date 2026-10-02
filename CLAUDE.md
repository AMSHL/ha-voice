# Голос

Аддон `voice` (`/addons/voice`): голосовой ассистент на старом айфоне.
Этапы 0–1 — страница и приём звука; Assist, слово активации, голоса, музыка — дальше.

- `server/server.py` — aiohttp: 8099 ingress, 8091 https (`/data/tls`, CN = `host_ip`).
  `ws`, `cert.crt`, `api/health`, `api/recordings`, `api/recordings/last.wav`;
  фразы в `/data/recordings`, последние 20.
- `server/public/`: `index.html` (`{{BASE}}`), `app.js`, `worklet.js`.
- WS: JSON `hello|mode|room`, `start|end|cancel`, `ping`; бинарь — int16 16 кГц
  моно, 320 отсчётов. Ответы: `level`, `saved`, `short`, `pong`.

## Правила
- Как в books: строки `config.yaml` в кавычках; `apply.sh` не качает; BusyBox —
  `grep -F -e`, сверки на python3; версию поднимать при правке сервера.
- Конфиг HA не трогать. Мост здесь не коммитит — коммит делает `apply.sh`.
- git: `main`, origin `AMSHL/ha-voice`, ключ `/config/.ssh/ha_voice_deploy`.
