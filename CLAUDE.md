# Голос

Аддон `voice` (`/addons/voice`): голосовой ассистент на старом айфоне.
Этапы 0–2a — страница, приём звука, спутник Wyoming (рация -> Assist -> ответ голосом);
3 (0.3.x) — кто говорит; режим «Слушать» и слово активации — 2b; музыка — дальше.

- `server/server.py` — aiohttp: 8099 ingress, 8091 https (`/data/tls`, CN = `host_ip`).
  `ws`, `cert.crt`, `api/health`, `api/recordings`, `api/recordings/last.wav`,
  `api/voices/<id>/last.wav`; фразы в `/data/recordings`, последние 20.
- `server/spk.py` — опознание: CAM++ (3D-Speaker, sherpa-onnx) `/opt/voice/spk.onnx`,
  fbank 80 на numpy + CMN, onnxruntime из apk (Alpine 3.23; в 3.21 пакета `py3-onnxruntime` нет). Образцы
  `/data/voices/<anatoly|evgeniya|leya>/NNN.wav|.npy`, центроид `c.npy`; лог `log.jsonl` (200).
  Порог `threshold` и отрыв `margin` — options. Хэш модели — `spk.sha256`.
- Имена = варианты `input_select.kto_govorit`: Неизвестно, Анатолий, Евгения, Лея.
  Жена — «Евгения» (id `evgeniya`), не «Женя»; старая папка `zhenya` переименовывается в `warm()`.
- Перед `run-pipeline`: опознание (≤1.5 с, иначе «Неизвестно», 0 %) -> Supervisor API
  `input_select.kto_govorit`, `input_number.kto_govorit_uverennost` -> ждём HA -> конвейер.
- `server/public/`: `index.html` (`{{BASE}}`, вкладки «Команды»/«Голоса»), `app.js`, `worklet.js`.
- WS: JSON `hello|mode|room`, `start|end|cancel` (`start` с `v: rec|check`, `p: <id>` —
  образец или проверка вместо HA), `vstat|vdel|vdelall`, `ping`; бинарь — int16 16 кГц
  моно, 320 отсчётов. Ответы: `level`, `saved`, `short`, `pong` (+`sat`), `nosat`, `who`,
  `vstat`, `vshort`, `vcheck`, `verr`, `sent`, `heard`, `answer`, `tts` + бинарь int16, `ttsend`, `perr`.
- Микрофон открыт, только пока держат «Сказать» или включено «Слушать».
- Wyoming (`class Sat`): 10700 Спальня, 10701 Гостиная, 10702 Детская.

## Правила
- Как в books: строки `config.yaml` в кавычках; `apply.sh` не качает; BusyBox —
  `grep -F -e`, сверки на python3; версию поднимать при правке сервера.
- Конфиг HA не трогать. Мост здесь не коммитит — коммит делает `apply.sh`.
- git: `main`, origin `AMSHL/ha-voice`, ключ `/config/.ssh/ha_voice_deploy`.

## Урок: сборка 0.3.0
- 0.3.0 не собрался («unknown error while trying to build the image»): `spk.sha256`
  закоммитили с заглушкой `FILL_ME`, и `sha256sum -c` в Dockerfile падал всегда.
- С 0.3.1 хэш сверяется, только если в `spk.sha256` записаны 64 hex-символа. Иначе
  сборка печатает строку `VOICE spk.sha256 не заполнен; модель: <хэш>`: впиши этот хэш
  в `spk.sha256` следующей версией.
- Нельзя коммитить заглушки в файлы, которые проверяются при сборке. Перед выпуском
  собери образ вручную: `docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23
  -t local/voice-test /addons/voice`, потом `docker rmi local/voice-test`. Если в сессии
  моста нет docker и сети, напиши об этом в отчёте.

## Урок: сборка 0.3.1
- 0.3.1 тоже не собрался: база `amd64-base:3.21`, а `py3-onnxruntime` в Alpine есть только
  с 3.23 (`apk add` -> «no such package»). База поднята до 3.23 (onnxruntime 1.23.0).
  Хэш модели вписан в `spk.sha256` (размер 28281164 совпадает с ассетом релиза).
- Ручная сборка «как Supervisor»: buildx есть только в `docker:<версия>-cli`, контекст —
  через tar: `tar -C /addons/voice --exclude=.git -cf - . | docker run --rm -i
  -v /var/run/docker.sock:/var/run/docker.sock docker:29.6.2-cli docker buildx build -
  --tag local/voice-test --platform linux/amd64 --pull --progress=plain`.
