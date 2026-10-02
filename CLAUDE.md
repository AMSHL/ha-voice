# Голос

Аддон `voice` (`/addons/voice`): голосовой ассистент на старом айфоне.
Этапы 0–2a — страница, приём звука, спутник Wyoming (рация -> Assist -> ответ голосом);
3 (0.3.x) — кто говорит; 2b (0.4.0) — «Слушать» со словом «Hey Jarvis»; 0.4.1 — потоковый ответ, уверенность, тайминги; 0.4.2 — сторож запуска; 0.4.3 — хотфикс сторожа; музыка — дальше.

- `server/server.py` — aiohttp: 8099 ingress, 8091 https (`/data/tls`, CN = `host_ip`).
  `ws`, `cert.crt`, `api/health`, `api/recordings`, `api/recordings/last.wav`,
  `api/voices/<id>/last.wav`; фразы в `/data/recordings`, последние 20.
- `server/spk.py` — опознание: CAM++ (3D-Speaker, sherpa-onnx) `/opt/voice/spk.onnx`,
  fbank 80 на numpy + CMN, onnxruntime из apk (Alpine 3.23; в 3.21 пакета `py3-onnxruntime` нет). Образцы
  `/data/voices/<anatoly|evgeniya|leya>/NNN.wav|.npy`, центроид `c.npy`; лог `log.jsonl` (200).
  Уверенность и порог — раздел «0.4.1». Хэш модели — `spk.sha256`.
- Имена = варианты `input_select.kto_govorit`: Неизвестно, Анатолий, Евгения, Лея.
  Жена — «Евгения» (id `evgeniya`), не «Женя»; старая папка `zhenya` переименовывается в `warm()`.
- Перед `run-pipeline`: опознание (≤1.5 с, иначе «Неизвестно», 0 %) -> Supervisor API
  `input_select.kto_govorit`, `input_number.kto_govorit_uverennost` -> ждём HA -> конвейер.
- `server/public/`: `index.html` (`{{BASE}}`, вкладки «Команды»/«Голоса»), `app.js`, `worklet.js`.
- WS: JSON `hello|mode|room`, `played`, `start|end|cancel` (`start` с `v: rec|check`, `p: <id>` —
  образец или проверка вместо HA), `vstat|vdel|vdelall`, `ping`; бинарь — int16 16 кГц
  моно, 320 отсчётов. Ответы: `level`, `saved`, `short`, `pong` (+`sat`), `nosat`, `who`,
  `vstat`, `vshort`, `vcheck`, `verr`, `sent`, `heard`, `answer`, `tts` + бинарь int16, `ttsend`, `perr`,
  `lstate` (`s`: wake|cmd|busy|none|nosat), `lost` (`text`, 0.4.2). `who|heard|answer|tts` несут `at` — мс от конца фразы.
- Микрофон открыт, только пока держат «Сказать» или включено «Слушать».
- Wyoming (`class Sat`): 10700 Спальня, 10701 Гостиная, 10702 Детская.

## «Слушать» (0.4.0, `class Listen`)
- Слово ловит HA: в конвейере «Клод» `wake_word.openwakeword`, `hey_jarvis` (аддон openWakeWord).
- Спутник шлёт `run-pipeline` wake -> **wake** и поток кадров. На `detection` HA сам заканчивает
  конвейер; команда режется здесь своим VAD (тишина `vad_tail`, 0.6 с, после ≥0.3 с речи, максимум 8 с, нет
  речи 4 с -> `none`), с 0.3 с до detection. Дальше `command()` — тот же путь, что у рации:
  запись, опознание -> хелперы, затем `run-pipeline` asr -> tts. Так хелперы точно раньше агента.
- Пока ждём ответ, в HA ничего не идёт (`busy`). Страница шлёт `played` после проигрывания
  (или если играть нечего) -> снова wake. Запас: ошибка HA -> 2 с, тишина -> 60 с (`tick` на ping).
- «Сказать» при «Слушать»: `hold()` закрывает поток wake (`audio-stop`), после ответа — снова wake.
  Ошибки от закрытого нами потока игнорируются (`ans`).
- Вкладка в фоне или экран заблокирован -> «Слушать» выключается, в статусе подсказка, тап по ней включает.

## Правила
- Как в books: строки `config.yaml` в кавычках; `apply.sh` не качает; BusyBox —
  `grep -F -e`, сверки на python3; версию поднимать при правке сервера.
- Конфиг HA не трогать. Мост здесь не коммитит — коммит делает `apply.sh`.
- git: `main`, origin `AMSHL/ha-voice`, ключ `/config/.ssh/ha_voice_deploy`; apply.sh делает push.

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

## Урок: iOS молчит в беззвучном режиме (0.3.3)
- Ответ доходил (audio-start 22050 Гц, ~12 с), текст был, звука нет: Web Audio в Safari
  слушается переключателя «беззвучно». Лечит `navigator.audioSession.type` (Safari 16.4+):
  `play-and-record`, пока открыт микрофон, иначе `playback` — он играет и в беззвучном.
- AudioContext создаётся/`resume()` только в жесте (`ensureCtx` на любой pointerdown/click)
  и там же играет беззвучный буфер. Перед ответом снова `resume()` с тайм-аутом 0.6 с:
  вне жеста промис может не завершиться. Не вышло — кнопка «Нажмите, чтобы услышать ответ».
- С 0.4.1 ответ играется потоком (см. ниже); целиком на `ttsend` — только запасной путь.
  `played` для HA шлёт сервер на audio-stop, как раньше.
- Проверка: строки «Звук», «Audio Session», «Последний ответ» в «Диагностике».
- `VERSION` в server.py обязан совпадать с `config.yaml`: apply.sh сверяет их.

## 0.4.1: скорость и уверенность
- Поток: на `tts` — `resume()` (≤0.6 с); копим 0.3 с, дальше куски ≥0.1 с встык
  (`AudioBufferSourceNode.start(t)`, `t += длина`); очередь опустела — новый старт через 50 мс.
  Контекст не запустился — ответ целиком на `ttsend`, кнопка «Нажмите…». `played` — после последнего куска.
- Уверенность, %: `100 / Σ exp((s_i − s_best) / conf_temp)` по всем близостям и якорю «неизвестный»
  `conf_anchor` (0.25), `conf_temp` 0.07. Учитывает и отрыв от второго, и абсолютную близость:
  0.47/0.16/0.10 -> 94, 0.40/0.15/0.10 -> 86, 0.45/0.40 -> 64, 0.30/0.27 -> 47, 0.25/0.05 -> 49.
  Ниже `min_conf` (70) -> «Неизвестно», 0 % в хелпер. Лог и «Проверить»: сырые `sims`, `best`, `conf`.
  `threshold`/`margin` убраны.
- «Диагностика» -> «От конца фразы»: опознание -> распознано -> агент (первое из synthesize/handled/
  audio-start) -> звук (часы страницы, привязка по `tts`). Конец фразы = срабатывание VAD.

## 0.4.2: зависание после таймаута агента
- Было: агент HA висел 60 с, следующий `run-pipeline` ушёл, а HA молчал; спутник idle, страница
  «Ответ …» навсегда, лечил только перезапуск. Причину внутри HA не подтвердили (логов HA не было);
  в аддоне не было ни сторожа, ни таймаута записи (`drain` в мёртвый сокет мог висеть вечно).
- Соединения HA нумеруются (`#N`), запуски — `run N`. `run()` пишет только в текущее `self.ha`;
  новый `run-satellite` закрывает старое соединение и его запуск; закрытие/`pause` соединения
  с запуском — тоже конец запуска. Запись в HA — `wait_for` 5 с.
- Сторож (`arm`/`watch`): после `run-pipeline` 5 с без событий конвейера (`FLOW`) -> «Home Assistant
  не ответил, попробуйте ещё раз» и соединение закрывается (HA переподключится — как перезапуск);
  после `transcript` 30 с без ответа -> «Ассистент не ответил»; после ответа 60 с без `audio-stop`
  -> тихий сброс. Конец запуска — `audio-stop` или `error`.
- Лог: `run N <комната> #C -> HA run-pipeline`, каждое событие `<- HA <комната> #C run N <тип>`,
  в конце `run N ... end: <причина> | events: <первые события>`.

## Урок: хотфикс 0.4.3 («name 'NOHA' is not defined»)
- В 0.4.2 сторож ссылался на тексты `NOHA` и `NOANS`, но их не объявили. `py_compile` такое
  не ловит: имя ищется только при выполнении, а `run()` вызывает `arm(..., NOHA)` на каждой
  команде — любая отправка падала «не удалось отправить в Home Assistant: name 'NOHA' is not defined».
- Перед выпуском, кроме `py_compile`, прогоняй `python3 -m pyflakes server/server.py server/spk.py`.
  Pyflakes на хосте нет — эквивалент на `symtable` (функция `undefined()` в fix.py черновика 0.4.3):
  каждое читаемое имя должно быть присвоено/импортировано на уровне модуля или быть встроенным.
  Неопределённое имя = не выпускать.
