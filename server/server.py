# Voice 2a: aiohttp on 8099 (ingress) and 8091 (https); Wyoming satellites 10700-10702.
import array, asyncio, json, math, os, ssl, time, wave
from aiohttp import WSMsgType, web
from wyoming.event import Event, async_read_event, async_write_event
from wyoming.info import Attribution, Info, Satellite
import spk

VERSION = "0.3.3"
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
        self.ha = self.ws = None

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
        elif t == "error":
            await self.to_page({"type": "perr", "text": d.get("text") or d.get("code") or "?"})


SATS = {r: Sat(r) for r in ROOMS}


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
    try:
        await ws_loop(ws)
    finally:
        for s in SATS.values():
            if s.ws is ws:
                s.ws = None
    return ws


async def ws_loop(ws):
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
        if m.type != WSMsgType.TEXT:
            continue
        try:
            d = json.loads(m.data)
        except ValueError:
            continue
        t = d.get("type")
        if d.get("room") in ROOMS:
            room = d["room"]
        if t == "hello":
            await send({"type": "hello", "version": VERSION})
        elif t == "ping":
            await send({"type": "pong", "t": d.get("t"), "sat": SATS[room].ha is not None})
        elif t == "start":
            ptt, vm = bytearray(), d
        elif t in ("vstat", "vdel", "vdelall"):
            await send(await spk.manage(t, d.get("p")))
        elif t == "cancel":
            ptt = None
        elif t == "end" and ptt is not None:
            pcm, ptt = bytes(ptt), None
            sec = round(len(pcm) / 2 / RATE, 2)
            if sec < MIN_SEC:
                await send({"type": "short", "sec": sec})
                continue
            if vm.get("v") in ("rec", "check"):
                await send(await spk.voice_cmd(vm["v"], vm.get("p"), pcm))
                continue
            name = await asyncio.get_running_loop().run_in_executor(None, save, room, pcm)
            print("[voice] saved", name, sec)
            await send({"type": "saved", "name": name, "sec": sec})
            sat = SATS[room]
            await send(await spk.before(sat.name, pcm))
            if sat.ha is None:
                await send({"type": "nosat", "room": sat.name})
                continue
            try:
                await sat.run(ws, pcm)
                await send({"type": "sent"})
            except Exception as e:
                print("[voice] send to HA failed:", e)
                await send({"type": "perr", "text": "не удалось отправить в Home Assistant: %s" % e})


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
