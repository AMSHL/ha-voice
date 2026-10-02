# Voice 0-1: aiohttp on 8099 (ingress) and 8091 (https).
import array, asyncio, json, math, os, ssl, time, wave
from aiohttp import WSMsgType, web

VERSION = "0.1.0"
PUB = os.path.dirname(os.path.abspath(__file__)) + "/public/"
REC, TLS = "/data/recordings/", "/data/tls/"
ROOMS = {"bedroom", "living", "kids"}
RATE, KEEP, MAX_SEC, MIN_SEC = 16000, 20, 60, 0.4
NC = {"Cache-Control": "no-store"}


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
    return web.json_response({"ok": True, "version": VERSION, "recordings": len(recs())})


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
            await send({"type": "pong", "t": d.get("t")})
        elif t == "start":
            ptt = bytearray()
        elif t == "cancel":
            ptt = None
        elif t == "end" and ptt is not None:
            pcm, ptt = bytes(ptt), None
            sec = round(len(pcm) / 2 / RATE, 2)
            if sec < MIN_SEC:
                await send({"type": "short", "sec": sec})
                continue
            name = await asyncio.get_running_loop().run_in_executor(None, save, room, pcm)
            print("[voice] saved", name, sec)
            await send({"type": "saved", "name": name, "sec": sec})
    return ws


async def main():
    app = web.Application()
    for path, h in (("/", index), ("/index.html", index), ("/ws", ws_handler), ("/cert.crt", cert),
                    ("/api/health", api_health), ("/api/recordings", api_recs),
                    ("/api/recordings/last.wav", api_last), ("/{name}", static)):
        app.router.add_get(path, h)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 8099).start()
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(TLS + "cert.pem", TLS + "key.pem")
    await web.TCPSite(runner, "0.0.0.0", 8091, ssl_context=ctx).start()
    print("[voice] v" + VERSION, "ingress 8099, https 8091")
    await asyncio.Event().wait()


asyncio.run(main())
