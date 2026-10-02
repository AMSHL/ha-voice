# Voice 0.4: aiohttp on 8099 (ingress) and 8091 (https); Wyoming satellites 10700-10702.
import array, asyncio, json, math, os, ssl, time, wave
from aiohttp import WSMsgType, web
from wyoming.event import Event, async_read_event, async_write_event
from wyoming.info import Attribution, Info, Satellite
import spk

VERSION = "0.4.0"
PUB = os.path.dirname(os.path.abspath(__file__)) + "/public/"
REC, TLS = "/data/recordings/", "/data/tls/"
ROOMS = {"bedroom": ("Спальня", 10700), "living": ("Гостиная", 10701), "kids": ("Детская", 10702)}
RATE, KEEP, MAX_SEC, MIN_SEC = 16000, 20, 60, 0.4
FMT, CHUNK = {"rate": RATE, "width": 2, "channels": 1}, 2048  # 1024 samples per chunk
NC = {"Cache-Control": "no-store"}


class Sat:
    """Wyoming satellite of one room: ha = HA connection after run-satellite, ws = page awaiting the answer."""

    def __init__(self, room):
        self.room, (self.name, self.port) = room, ROOMS[room]
        self.ha = self.ws = self.lis = None  # lis: Listen of the page with «Слушать» on

    def info(self):
        return Info(satellite=Satellite(
            name="Голос: " + self.name, area=self.name, installed=True, version=VERSION,
            description="Айфон, " + self.name, attribution=Attribution(name="Home Voice", url=""))).event()

    async def to_ha(self, typ, data=None, payload=None):
        await async_write_event(Event(typ, data or {}, payload), self.ha)

    async def to_page(self, o):
        ws = self.ws
        if ws is None or ws.closed:
            return
        try:
            await (ws.send_bytes(o) if isinstance(o, bytes) else ws.send_str(json.dumps(o)))
        except Exception:
            pass

    async def run(self, ws, pcm):
        # Push-to-talk: the whole phrase (with 0.3 s pre-roll from the page) goes to an asr -> tts pipeline.
        self.ws = ws
        print("[voice] -> HA", self.name, "run-pipeline", round(len(pcm) / 2 / RATE, 2))
        await self.to_ha("run-pipeline", {"start_stage": "asr", "end_stage": "tts", "restart_on_end": False})
        await asyncio.sleep(0.3)  # let HA start the pipeline before audio arrives
        await self.to_ha("audio-start", {**FMT, "timestamp": 0})
        for i in range(0, len(pcm), CHUNK):
            await self.to_ha("audio-chunk", {**FMT, "timestamp": i // 32}, pcm[i:i + CHUNK])
        await self.to_ha("audio-stop", {"timestamp": len(pcm) // 32})

    async def serve(self, reader, writer):
        print("[voice] HA connected to", self.name, writer.get_extra_info("peername"))
        try:
            while (ev := await async_read_event(reader)) is not None:
                await self.on_event(ev, writer)
        except Exception as e:
            print("[voice]", self.name, "connection error:", e)
        finally:
            if self.ha is writer:
                self.ha = None
            print("[voice] HA disconnected from", self.name)
            writer.close()

    async def on_event(self, ev, w):
        t, d = ev.type, ev.data or {}
        if t != "audio-chunk":
            print("[voice] <- HA", self.name, t, json.dumps(d, ensure_ascii=False)[:200])
        if t == "describe":
            await async_write_event(self.info(), w)
        elif t == "ping":
            await async_write_event(Event("pong", {"text": d.get("text")}), w)
        elif t == "run-satellite":
            self.ha = w
        elif t == "pause-satellite" and self.ha is w:
            self.ha = None
        elif t == "transcript":
            await self.to_page({"type": "heard", "text": d.get("text") or ""})
        elif t in ("synthesize", "handled", "not-handled"):
            await self.to_page({"type": "answer", "text": d.get("text") or ""})
        elif t == "audio-start":
            await self.to_page({"type": "tts", **{k: d.get(k, v) for k, v in FMT.items()}})
        elif t == "audio-chunk" and ev.payload:
            await self.to_page(ev.payload)
        elif t == "audio-stop":
            await self.to_page({"type": "ttsend"})
            await async_write_event(Event("played", {}), w)
        elif t == "detection" and self.lis:
            await self.lis.detected()
        elif t == "error":
            if self.lis:
                self.lis.err()
            await self.to_page({"type": "perr", "text": d.get("text") or d.get("code") or "?"})


SATS = {r: Sat(r) for r in ROOMS}


class Listen:
    """«Слушать»: HA hears the wake word (pipeline wake -> wake). After detection the command is cut here
    by own VAD, then who -> helpers -> asr pipeline like push-to-talk, so the helpers are set first."""
    PRE, TAIL, MAXC, NOVOICE, VOICED = 15, 0.8, 8.0, 4.0, 0.3

    def __init__(self, ws):
        self.ws, self.room, self.sat, self.ha, self.st, self.t, self.ans = ws, None, None, None, "off", 0.0, False
        self.ring, self.buf, self.noise, self.voiced, self.quiet, self.ts = [], bytearray(), -60.0, 0.0, 0.0, 0

    async def tell(self, s):
        try:
            await self.ws.send_str(json.dumps({"type": "lstate", "s": s}))
        except Exception:
            pass

    def later(self, sec):  # st "busy": nothing goes to HA; tick() restarts the wake stream after sec
        self.st, self.t = "busy", time.monotonic() + sec

    async def set(self, on, room):
        if on and self.st != "off" and room == self.room:
            return
        await self.stop()
        if on:
            self.room, self.sat = room, SATS[room]
            self.sat.lis = self
            await self.wake()

    async def wake(self):
        sat, self.ans = self.sat, False
        if sat.ha is None:
            self.later(3)
            return await self.tell("nosat")
        self.ring, self.ts, self.ha = [], 0, sat.ha
        try:
            await sat.to_ha("run-pipeline", {"start_stage": "wake", "end_stage": "wake", "restart_on_end": False})
            await sat.to_ha("audio-start", {**FMT, "timestamp": 0})
        except Exception as e:
            print("[voice] wake start failed:", e)
            return self.later(3)
        self.st = "wake"
        await self.tell("wake")

    async def hold(self, sec=60):  # push-to-talk or a command is running: stop the wake stream
        if self.st == "wake" and self.ha is not None and self.ha is self.sat.ha:
            try:
                await self.sat.to_ha("audio-stop", {"timestamp": self.ts})
            except Exception:
                pass
        if self.st != "off":
            self.later(sec)
        self.ans = False

    async def stop(self):
        await self.hold()
        if self.sat is not None and self.sat.lis is self:
            self.sat.lis = None
        self.st = "off"

    async def done(self):  # answer played, or nothing to wait for: back to the wake word
        if self.st == "busy":
            await self.wake()

    def err(self):  # errors of a wake stream we stopped ourselves are ignored
        if self.st == "wake" or (self.st == "busy" and self.ans):
            self.later(2)

    async def tick(self):  # on every page ping (2 s)
        if self.st == "busy" and time.monotonic() > self.t:
            await self.wake()
        elif self.st == "wake" and self.ha is not self.sat.ha:
            await self.wake()

    async def detected(self):
        if self.st != "wake":
            return
        # The wake pipeline ends by itself (end_stage wake); 0.3 s before detection is kept as pre-roll.
        self.st, self.buf, self.voiced, self.quiet = "cmd", bytearray(b"".join(self.ring)), 0.0, 0.0
        print("[voice] wake word", self.sat.name)
        await self.tell("cmd")

    async def frame(self, data):
        if self.st not in ("wake", "cmd"):
            return
        a = array.array("h", data)
        db, dur = 10 * math.log10(sum(x * x for x in a) / max(len(a), 1) / 2 ** 30 + 1e-10), len(a) / RATE
        if self.st == "wake":
            self.noise += (db - self.noise) * (0.1 if db < self.noise else 0.005)
            self.ring = (self.ring + [data])[-self.PRE:]
            try:
                await self.sat.to_ha("audio-chunk", {**FMT, "timestamp": self.ts}, data)
            except Exception:
                return self.later(2)
            self.ts += round(dur * 1000)
            return
        self.buf.extend(data)
        if db > max(self.noise + 10, -55):
            self.voiced, self.quiet = self.voiced + dur, 0.0
        else:
            self.quiet += dur
        sec = len(self.buf) / 2 / RATE
        if (self.voiced >= self.VOICED and self.quiet >= self.TAIL) or sec >= self.MAXC or (
                self.voiced < self.VOICED and sec >= self.NOVOICE):
            await self.finish()

    async def finish(self):
        pcm, voiced = bytes(self.buf), self.voiced
        self.buf = bytearray()
        await self.hold()
        print("[voice] command", self.sat.name, round(len(pcm) / 2 / RATE, 2), "voiced", round(voiced, 2))
        if voiced < self.VOICED:
            await self.tell("none")
            return await self.wake()
        await self.tell("busy")
        self.ans = await command(self.ws, self.room, pcm)
        if not self.ans:
            self.later(2)


async def command(ws, room, pcm):
    """Phrase -> saved, who -> helpers, then the asr pipeline (push-to-talk and «Слушать»). True if sent."""
    send = lambda o: ws.send_str(json.dumps(o))
    sec = round(len(pcm) / 2 / RATE, 2)
    name = await asyncio.get_running_loop().run_in_executor(None, save, room, pcm)
    print("[voice] saved", name, sec)
    await send({"type": "saved", "name": name, "sec": sec})
    sat = SATS[room]
    await send(await spk.before(sat.name, pcm))
    if sat.ha is None:
        await send({"type": "nosat", "room": sat.name})
        return False
    try:
        await sat.run(ws, pcm)
        await send({"type": "sent"})
        return True
    except Exception as e:
        print("[voice] send to HA failed:", e)
        await send({"type": "perr", "text": "не удалось отправить в Home Assistant: %s" % e})
        return False


async def index(req):
    with open(PUB + "index.html", encoding="utf-8") as f:
        html = f.read().replace("{{BASE}}", req.headers.get("X-Ingress-Path", ""))
    return web.Response(text=html, content_type="text/html", headers=NC)


async def static(req):
    name = req.match_info["name"]
    if name not in ("app.js", "worklet.js"):
        raise web.HTTPNotFound()
    return web.FileResponse(PUB + name, headers={"Content-Type": "text/javascript", **NC})


async def cert(req):
    with open(TLS + "cert.pem", "rb") as f:
        return web.Response(body=f.read(), content_type="application/x-x509-ca-cert")


def recs():
    names = os.listdir(REC) if os.path.isdir(REC) else []
    return sorted((n for n in names if n.endswith(".wav") and n[0] != "."), reverse=True)


def save(room, pcm):
    os.makedirs(REC, exist_ok=True)
    t = time.time()
    name = time.strftime("%Y%m%d-%H%M%S", time.localtime(t)) + "-%03d_%s.wav" % (t * 1000 % 1000, room)
    with wave.open(REC + "." + name, "wb") as w:
        w.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        w.writeframes(pcm)
    os.replace(REC + "." + name, REC + name)
    for old in recs()[KEEP:]:
        os.remove(REC + old)
    return name


async def api_health(req):
    return web.json_response({"ok": True, "version": VERSION, "recordings": len(recs()),
                              "satellites": {r: s.ha is not None for r, s in SATS.items()}})


async def api_recs(req):
    return web.json_response({"items": [
        {"name": n, "sec": round((os.path.getsize(REC + n) - 44) / 2 / RATE, 2)} for n in recs()]})


async def api_last(req):
    names = recs()
    if not names:
        raise web.HTTPNotFound()
    return web.FileResponse(REC + names[0], headers={"Content-Type": "audio/wav", **NC})


async def ws_handler(req):
    ws = web.WebSocketResponse(heartbeat=15, max_msg_size=1 << 20)
    await ws.prepare(req)
    lis = Listen(ws)
    try:
        await ws_loop(ws, lis)
    finally:
        await lis.stop()
        for s in SATS.values():
            if s.ws is ws:
                s.ws = None
    return ws


async def ws_loop(ws, lis):
    room, ptt, sq, n, last = "bedroom", None, 0.0, 0, time.monotonic()
    send = lambda o: ws.send_str(json.dumps(o))
    async for m in ws:
        if m.type == WSMsgType.BINARY and len(m.data) % 2 == 0:
            if ptt is not None and len(ptt) < MAX_SEC * RATE * 2:
                ptt.extend(m.data)
            a = array.array("h", m.data)
            sq += sum(x * x for x in a)
            n += len(a)
            if n and time.monotonic() - last >= 0.2:
                await send({"type": "level", "db": round(20 * math.log10(max(math.sqrt(sq / n), 1) / 32768), 1)})
                sq, n, last = 0.0, 0, time.monotonic()
            await lis.frame(m.data)
        if m.type != WSMsgType.TEXT:
            continue
        try:
            d = json.loads(m.data)
        except ValueError:
            continue
        t = d.get("type")
        if d.get("room") in ROOMS:
            room = d["room"]
        if t in ("hello", "mode"):
            await lis.set(d.get("mode") == "listen", room)
        if t == "hello":
            await send({"type": "hello", "version": VERSION})
        elif t == "ping":
            await send({"type": "pong", "t": d.get("t"), "sat": SATS[room].ha is not None})
            await lis.tick()
        elif t == "played":
            await lis.done()
        elif t == "start":
            await lis.hold()
            ptt, vm = bytearray(), d
        elif t in ("vstat", "vdel", "vdelall"):
            await send(await spk.manage(t, d.get("p")))
        elif t == "cancel":
            ptt = None
            await lis.done()
        elif t == "end" and ptt is not None:
            pcm, ptt = bytes(ptt), None
            sec = round(len(pcm) / 2 / RATE, 2)
            if sec < MIN_SEC:
                await send({"type": "short", "sec": sec})
            elif vm.get("v") in ("rec", "check"):
                await send(await spk.voice_cmd(vm["v"], vm.get("p"), pcm))
            elif await command(ws, room, pcm):
                lis.ans = lis.st == "busy"
                continue
            await lis.done()


async def main():
    app = web.Application()
    for path, h in (("/", index), ("/index.html", index), ("/ws", ws_handler), ("/cert.crt", cert),
                    ("/api/health", api_health), ("/api/recordings", api_recs),
                    ("/api/recordings/last.wav", api_last), ("/api/voices/{p}/last.wav", spk.last_wav), ("/{name}", static)):
        app.router.add_get(path, h)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 8099).start()
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(TLS + "cert.pem", TLS + "key.pem")
    await web.TCPSite(runner, "0.0.0.0", 8091, ssl_context=ctx).start()
    for s in SATS.values():
        await asyncio.start_server(s.serve, "0.0.0.0", s.port)
    await asyncio.get_running_loop().run_in_executor(None, spk.warm)
    print("[voice] v" + VERSION, "ingress 8099, https 8091, wyoming 10700-10702")
    await asyncio.Event().wait()


asyncio.run(main())
