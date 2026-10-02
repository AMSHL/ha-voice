# Voice 0.3: who is speaking. 3D-Speaker CAM++ ONNX embeddings over a numpy Kaldi-style fbank.
import asyncio, json, os, time, wave
import aiohttp
import numpy as np
from aiohttp import web

MODEL, VD = "/opt/voice/spk.onnx", "/data/voices/"
PEOPLE = {"anatoly": "Анатолий", "evgeniya": "Евгения", "leya": "Лея"}
UNK = "Неизвестно"
OPT = {"threshold": 0.45, "margin": 0.08}
try:
    with open("/data/options.json") as f:
        OPT.update({k: v for k, v in json.load(f).items() if k in OPT})
except Exception:
    pass
cent, _sess = {}, None


def _mel(n=80, nfft=512, sr=16000, lo=20.0):
    m = lambda f: 1127 * np.log(1 + f / 700)
    pts, fm = np.linspace(m(lo), m(sr / 2), n + 2), m(np.arange(nfft // 2 + 1) * sr / nfft)
    return np.array([np.maximum(0, np.minimum((fm - l) / (c - l), (r - fm) / (r - c)))
                     for l, c, r in zip(pts, pts[1:], pts[2:])], np.float32)


MEL = _mel()
WIN = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(400) / 399)) ** 0.85  # povey


def fbank(x):  # 80-dim log mel, 25/10 ms, no dither, then CMN (makes it scale-invariant)
    n = 1 + (len(x) - 400) // 160
    f = x[np.arange(400)[None] + 160 * np.arange(n)[:, None]]
    f = f - f.mean(1, keepdims=True)
    f = np.concatenate([f[:, :1] * 0.03, f[:, 1:] - 0.97 * f[:, :-1]], 1) * WIN
    e = np.log(np.maximum((np.abs(np.fft.rfft(f, 512)) ** 2) @ MEL.T, 1.19e-7))
    return e - e.mean(0)


def speech(pcm):  # (seconds of speech, voiced samples): 20 ms frames within 25 dB of the loudest
    a = np.frombuffer(pcm, np.int16).astype(np.float32)
    fr = a[:len(a) // 320 * 320].reshape(-1, 320)
    db = 10 * np.log10((fr ** 2).mean(1) / 2 ** 30 + 1e-10)
    if not len(db) or db.max() < -40:
        return 0.0, a
    v = db > max(-50, db.max() - 25)
    return round(v.sum() * 0.02, 2), fr[v].reshape(-1)


def embed(a):
    global _sess
    if _sess is None:
        import onnxruntime as ort
        o = ort.SessionOptions()
        o.intra_op_num_threads = 2
        _sess = ort.InferenceSession(MODEL, o, providers=["CPUExecutionProvider"])
    e = _sess.run(None, {_sess.get_inputs()[0].name: fbank(a)[None].astype(np.float32)})[0].reshape(-1)
    return e / (np.linalg.norm(e) + 1e-9)


def samples(p):
    d = VD + p + "/"
    return sorted(n[:-4] for n in os.listdir(d) if n.endswith(".npy") and n != "c.npy") if os.path.isdir(d) else []


def recalc(p):
    d, s = VD + p + "/", samples(p)
    if s:
        c = np.mean([np.load(d + n + ".npy") for n in s], 0)
        cent[p] = c / np.linalg.norm(c)
        np.save(d + "c.npy", cent[p])
    else:
        cent.pop(p, None)
        if os.path.exists(d + "c.npy"):
            os.remove(d + "c.npy")
    return len(s)


def enroll(p, pcm):
    sec, a = speech(pcm)
    if sec < 1:
        return {"type": "vshort", "sec": sec}
    e, d, s = embed(a), VD + p + "/", samples(p)
    os.makedirs(d, exist_ok=True)
    n = "%03d" % (int(s[-1]) + 1 if s else 1)
    with wave.open(d + n + ".wav", "wb") as w:
        w.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        w.writeframes(pcm)
    np.save(d + n + ".npy", e)
    return {"type": "vstat", "p": p, "n": recalc(p), "ok": 1}


def _manage(t, p):
    d, s = VD + p + "/", samples(p)
    for n in s if t == "vdelall" else s[-1:] if t == "vdel" else []:
        for x in (".wav", ".npy"):
            if os.path.exists(d + n + x):
                os.remove(d + n + x)
    return {"type": "vstat", "p": p, "n": recalc(p)}


def identify(pcm):
    sec, a = speech(pcm)
    if sec < 0.5:
        raise ValueError("мало речи (%s с)" % sec)
    e = embed(a)
    sims = {PEOPLE[p]: round(float(c @ e), 3) for p, c in list(cent.items())}
    r = sorted(sims.values(), reverse=True) + [-1.0]
    if r[0] >= OPT["threshold"] and r[0] - r[1] >= OPT["margin"]:
        return max(sims, key=sims.get), round(r[0] * 100), sims
    return UNK, 0, sims


def warm():
    old, new = VD + "zhenya", VD + "evgeniya"  # 0.3.1: «Женя» -> «Евгения»
    if os.path.isdir(old) and not os.path.exists(new):
        try:
            os.rename(old, new)
            print("[voice] voices: zhenya -> evgeniya")
        except OSError as e:
            print("[voice] voices rename:", e)
    for p in PEOPLE:
        try:
            recalc(p)
        except Exception as e:
            print("[voice] voices of", p, e)
    try:
        embed(np.random.randn(32000).astype(np.float32) * 300)
    except Exception as e:
        print("[voice] speaker model:", e)


def log(rec):
    os.makedirs(VD, exist_ok=True)
    try:
        with open(VD + "log.jsonl", encoding="utf-8") as f:
            lines = f.read().splitlines()[-199:]
    except OSError:
        lines = []
    lines.append(json.dumps(rec, ensure_ascii=False))
    with open(VD + "log.jsonl", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


async def ha(svc, data):
    h = {"Authorization": "Bearer " + os.environ.get("SUPERVISOR_TOKEN", "")}
    async with aiohttp.ClientSession() as s:
        async with s.post("http://supervisor/core/api/services/" + svc, json=data, headers=h) as r:
            if r.status >= 300:
                raise RuntimeError("HTTP %s" % r.status)


async def before(room, pcm):  # who spoke -> HA helpers, awaited before the pipeline; never raises
    t, who, pct, sims, err = time.monotonic(), UNK, 0, {}, None
    if cent:
        try:
            who, pct, sims = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(None, identify, pcm), 1.5)
        except Exception as e:
            err = str(e) or type(e).__name__
    ms = round((time.monotonic() - t) * 1000)
    try:
        await asyncio.wait_for(asyncio.gather(
            ha("input_select/select_option", {"entity_id": "input_select.kto_govorit", "option": who}),
            ha("input_number/set_value", {"entity_id": "input_number.kto_govorit_uverennost", "value": pct})), 3)
    except Exception as e:
        err = (err or "") + " HA: " + (str(e) or type(e).__name__)
    rec = {"t": time.strftime("%Y-%m-%d %H:%M:%S"), "room": room, "who": who, "pct": pct,
           "sims": sims, "ms": ms, "err": err}
    print("[voice] who", json.dumps(rec, ensure_ascii=False))
    try:
        log(rec)
    except OSError as e:
        print("[voice] log:", e)
    return {"type": "who", **rec}


async def voice_cmd(v, p, pcm):  # "rec": save a sample of p; "check": identify, nothing sent to HA
    run = lambda f, *a: asyncio.get_running_loop().run_in_executor(None, f, *a)
    try:
        if v == "rec":
            return await run(enroll, p, pcm) if p in PEOPLE else {"type": "verr", "text": "не выбран человек"}
        if not cent:
            return {"type": "verr", "text": "образцов ещё нет"}
        t = time.monotonic()
        who, pct, sims = await run(identify, pcm)
        return {"type": "vcheck", "who": who, "pct": pct, "sims": sims, "ms": round((time.monotonic() - t) * 1000)}
    except Exception as e:
        return {"type": "verr", "text": str(e) or type(e).__name__}


async def manage(t, p):
    if p not in PEOPLE:
        return {"type": "verr", "text": "не выбран человек"}
    return await asyncio.get_running_loop().run_in_executor(None, _manage, t, p)


async def last_wav(req):
    p = req.match_info["p"]
    s = samples(p) if p in PEOPLE else []
    if not s:
        raise web.HTTPNotFound()
    return web.FileResponse(VD + p + "/" + s[-1] + ".wav", headers={"Content-Type": "audio/wav", "Cache-Control": "no-store"})
