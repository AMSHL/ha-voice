// Voice 2a: mic -> 16 kHz int16, 20 ms frames -> WebSocket; answer audio back -> Web Audio.
// Mic is open only while "Сказать" is held or "Слушать" is on; AudioContext stays for playback.
const $ = id => document.getElementById(id);
const set = (id, t) => { $(id).textContent = t; };
const PRE = 15, MIN_HOLD = 400; // 15 frames = 0.3 s pre-roll (only with "Слушать")
let room = localStorage.getItem('voice.room');
if (!['bedroom', 'living', 'kids'].includes(room)) room = 'bedroom';
let listening = false, ptt = null, ws = null, ok = false, retry = 1000;
let pre = [], ctx = null, mute = null, wl = null, mic = null, micP = null, pong = 0, stT = 0, lvlT = 0, peak = -100;

function status(t, err) { $('status').textContent = t; $('status').className = err ? 'err' : ''; }
function idle() { status(ptt ? (ptt.live ? 'Говорите…' : 'Готовлюсь…') : listening ? 'Слушаю' : 'Ожидание'); }
function flash(t, err) { status(t, err); clearTimeout(stT); stT = setTimeout(idle, err ? 4000 : 2000); }
const sendJ = o => ok && ws.send(JSON.stringify(o));
const sendB = b => ok && ws.send(b);
const mode = () => ({ type: 'mode', room, mode: listening ? 'listen' : 'idle' });

function drawRooms() { for (const b of $('rooms').children) b.classList.toggle('on', b.dataset.r === room); }
$('rooms').onclick = e => {
  const r = e.target.dataset.r;
  if (!r) return;
  room = r; localStorage.setItem('voice.room', r); drawRooms(); sendJ(mode());
};

function connect() {
  set('dNet', 'подключение…');
  const u = new URL('ws', document.baseURI);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const s = ws = new WebSocket(u.href);
  s.binaryType = 'arraybuffer';
  s.onopen = () => {
    ok = true; retry = 1000; pong = performance.now(); set('dNet', 'есть');
    sendJ({ ...mode(), type: 'hello' });
  };
  s.onmessage = e => typeof e.data === 'string' ? onMsg(JSON.parse(e.data)) : tts(e.data);
  s.onclose = () => { if (ws === s) drop(); };
}
function drop() {
  const s = ws; ws = null; ok = false;
  s.onclose = null; s.close();
  set('dNet', 'нет, переподключаюсь…'); set('lvlSrv', '—');
  if (ptt) { release(ptt.id, true); flash('Ошибка: связь пропала', 1); }
  setTimeout(connect, retry); retry = Math.min(retry * 2, 10000);
}
setInterval(() => {
  if (!ok) return;
  if (performance.now() - pong > 7000) return drop();
  sendJ({ type: 'ping', t: performance.now() });
}, 2000);
let fmt = null, playT = 0;
function tts(buf) { // int16 chunk of the answer, format from the last 'tts' message
  if (!ctx || !fmt || fmt.width !== 2) return;
  const ch = fmt.channels || 1, a = new Int16Array(buf, 0, buf.byteLength >> 1), n = Math.floor(a.length / ch);
  if (!n) return;
  const b = ctx.createBuffer(ch, n, fmt.rate);
  for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = a[i * ch + c] / 32768; }
  const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination);
  playT = Math.max(playT, ctx.currentTime + 0.1); s.start(playT); playT += b.duration;
}
function onMsg(m) {
  if (m.type[0] === 'v' || m.type === 'who') return vMsg(m);
  if (m.type === 'nosat') flash('Home Assistant не подключён к спутнику ' + m.room, 1);
  if (m.type === 'sent') { clearTimeout(stT); status('Распознаю…'); stT = setTimeout(idle, 15000); set('heard', '…'); set('answer', '…'); }
  if (m.type === 'heard') set('heard', m.text || '(ничего не распознано)');
  if (m.type === 'answer') set('answer', m.text || '—');
  if (m.type === 'tts') { fmt = m; clearTimeout(stT); status('Отвечаю…'); stT = setTimeout(idle, 15000); }
  if (m.type === 'ttsend') { clearTimeout(stT); stT = setTimeout(idle, Math.max(0, playT - (ctx ? ctx.currentTime : 0)) * 1000); }
  if (m.type === 'perr') { flash('Ошибка: ' + m.text, 1); set('answer', 'Ошибка: ' + m.text); }
  if (m.type === 'hello') set('ver', 'v' + m.version);
  if (m.type === 'pong') { pong = performance.now(); set('dRtt', Math.round(pong - m.t) + ' мс'); set('dSat', m.sat ? 'подключён' : 'не подключён'); }
  if (m.type === 'level' && mic) set('lvlSrv', m.db + ' дБ');
  if (m.type === 'saved') { flash('Отправлено: ' + m.sec + ' с'); loadRec(); }
  if (m.type === 'short') flash('Слишком коротко');
}

// Called synchronously inside a tap: iOS lets an AudioContext start only from a gesture.
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    mute = ctx.createGain(); mute.gain.value = 0; mute.connect(ctx.destination);
    wl = ctx.audioWorklet.addModule('worklet.js');
    wake();
  }
  if (ctx.state !== 'running') ctx.resume();
}
const wantMic = () => listening || !!ptt;
function openMic() {
  if (mic) return Promise.resolve(mic);
  return micP || (micP = (async () => {
    set('dMic', 'открываю…');
    let st = null;
    try {
      st = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      await wl;
      if (!wantMic()) { st.getTracks().forEach(t => t.stop()); set('dMic', 'выключен'); return null; }
      const src = ctx.createMediaStreamSource(st), node = new AudioWorkletNode(ctx, 'pcm16k');
      src.connect(node).connect(mute);
      node.port.onmessage = e => onFrame(e.data);
      st.getAudioTracks()[0].onended = () => {
        if (ptt) release(ptt.id, true);
        if (listening) setListen(false);
        closeMic(); flash('Ошибка: микрофон отключён', 1);
      };
      mic = { st, src, node };
      set('dMic', 'открыт'); set('dRate', ctx.sampleRate + ' → 16000 Гц');
      if (listening) listen.lastChild.textContent = 'поток идёт';
      return mic;
    } catch (e) {
      if (st && !mic) st.getTracks().forEach(t => t.stop());
      throw e;
    } finally { micP = null; }
  })());
}
function closeMic() { // track.stop() turns off the orange iOS indicator
  pre = [];
  if (!mic) return;
  const m = mic; mic = null;
  m.node.port.onmessage = null;
  m.st.getTracks().forEach(t => { t.onended = null; t.stop(); });
  m.src.disconnect(); m.node.disconnect();
  set('dMic', 'выключен'); set('lvlMic', 'выключен'); set('lvlSrv', '—'); $('lvl').style.width = '0';
}
function micErr(e) {
  set('dMic', 'ошибка: ' + (e.name || e));
  if (ptt) { ptt = null; sayUi(false); }
  if (listening) setListen(false);
  flash('Ошибка: ' + (e.name === 'NotAllowedError' ? 'нет доступа к микрофону' : e.message || e), 1);
}

function onFrame(buf) {
  const a = new Int16Array(buf);
  let sq = 0;
  for (const v of a) sq += v * v;
  peak = Math.max(peak, 10 * Math.log10(sq / a.length / 2 ** 30 + 1e-10));
  if (performance.now() - lvlT > 100) {
    $('lvl').style.width = Math.max(0, Math.min(100, (peak + 60) * 5 / 3)) + '%';
    set('lvlMic', Math.round(peak) + ' дБ'); peak = -100; lvlT = performance.now();
  }
  if (ptt && !ptt.live) { // first real (non-zero) frame: now the person may speak
    if (!sq) return;
    goLive(ptt);
  }
  if (ptt || listening) sendB(buf);
  pre.push(buf); if (pre.length > PRE) pre.shift();
}

const listen = $('listen'), say = $('say');
function setListen(on) {
  listening = on;
  listen.classList.toggle('on', on);
  listen.lastChild.textContent = on ? (mic ? 'поток идёт' : 'включаю…') : 'выключено';
  sendJ(mode()); idle();
  if (!on && !ptt) closeMic();
}
listen.onclick = () => {
  if (listening) return setListen(false);
  ensureCtx(); setListen(true);
  openMic().catch(micErr);
};

function sayUi(s) {
  say.classList.toggle('prep', s === 'prep'); say.classList.toggle('down', s === 'talk'); say.classList.remove('out');
  say.lastChild.textContent = s === 'prep' ? 'готовлюсь…' : s === 'talk' ? 'говорите' : 'держите и говорите';
}
function goLive(p) {
  p.live = true; p.t = performance.now();
  sendJ({ type: 'start', room, ...vmode() });
  sayUi('talk'); if (!p.out) idle();
}
say.oncontextmenu = e => e.preventDefault();
say.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
say.onpointerdown = e => {
  if (ptt) return;
  if (!ok) return flash('Ошибка: нет связи', 1);
  ensureCtx();
  try { say.setPointerCapture(e.pointerId); } catch (_) {}
  const p = ptt = { id: e.pointerId, out: false, live: false, t: 0 };
  clearTimeout(stT);
  if (mic && listening) { goLive(p); pre.forEach(b => sendB(b)); return; }
  sayUi('prep'); idle();
  openMic().catch(micErr);
};
say.onpointermove = e => {
  if (!ptt || e.pointerId !== ptt.id) return;
  const r = say.getBoundingClientRect();
  ptt.out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  say.classList.toggle('out', ptt.out);
  if (ptt.out) status('Отпустите — отмена'); else idle();
};
function release(id, cancel) { // idempotent: every end/cancel path lands here
  const p = ptt;
  if (!p || id !== p.id) return;
  ptt = null; sayUi(false);
  if (!p.live) flash(cancel || p.out ? 'Отменено' : 'Держите кнопку чуть дольше');
  else if (cancel || p.out || performance.now() - p.t < MIN_HOLD) {
    sendJ({ type: 'cancel' }); flash(cancel || p.out ? 'Отменено' : 'Коротко: держите кнопку чуть дольше');
  } else { sendJ({ type: 'end' }); status('Отправляю…'); }
  if (!listening) closeMic();
}
say.onpointerup = e => release(e.pointerId, false);
say.onpointercancel = e => release(e.pointerId, true);
say.onlostpointercapture = e => release(e.pointerId, false);
// Safety net: no finger left on the button -> the press is over, whatever pointer events did.
const touchEnd = cancel => e => {
  if (ctx && ctx.state !== 'running') ctx.resume();
  if (ptt && !Array.from(e.touches).some(t => say.contains(t.target))) release(ptt.id, cancel);
};
document.addEventListener('touchend', touchEnd(false));
document.addEventListener('touchcancel', touchEnd(true));

async function wake() {
  try {
    const l = await navigator.wakeLock.request('screen');
    set('dWake', 'не гаснет'); l.onrelease = () => set('dWake', 'может погаснуть');
  } catch (e) { set('dWake', 'Wake Lock нет: ' + e.name); }
}
function away() { // left the page: cancel the press and close the mic
  if (ptt) release(ptt.id, true);
  if (listening) setListen(false);
  closeMic();
}
document.onvisibilitychange = () => {
  if (document.hidden) return away();
  if (ctx) { ctx.resume(); wake(); }
};
window.addEventListener('pagehide', away);

async function loadRec() {
  try {
    const j = await (await fetch('api/recordings', { cache: 'no-store' })).json(), x = j.items[0];
    set('recinfo', x ? x.name + ' · ' + x.sec + ' с · всего ' + j.items.length : 'Записей нет');
  } catch (e) { set('recinfo', 'Нет списка'); }
}
$('play').onclick = () => {
  const a = $('audio');
  a.hidden = false; a.src = 'api/recordings/last.wav?t=' + Date.now(); a.play().catch(() => {});
};

set('dSec', isSecureContext ? 'да' : 'нет — микрофона не будет');
drawRooms(); loadRec(); connect();

// 0.3 "Голоса" tab: the same push-to-talk records a sample of the chosen person or checks who is speaking.
const PH = ['Включи свет на кухне', 'Какая завтра погода?', 'Поставь будильник на семь утра',
  'Выключи телевизор в гостиной', 'Сделай потеплее в спальне', 'Открой шторы', 'Сколько сейчас времени?',
  'Напомни купить хлеб и молоко', 'Включи музыку потише', 'Закрой ворота', 'Мы идём гулять с собакой',
  'Шла Саша по шоссе и сосала сушку', 'Сегодня отличный солнечный день', 'В лесу родилась ёлочка',
  'Позвони бабушке вечером', 'Почитай мне сказку', 'Какие новости на сегодня?',
  'Выключи везде свет, мы спим', 'Раз, два, три, четыре, пять', 'Кондиционер на двадцать три градуса'];
let tab = 'cmd', vm = 'rec', phi = Math.floor(Math.random() * PH.length), per = localStorage.getItem('voice.p');
if (per === 'zhenya') per = 'evgeniya';
if (!['anatoly', 'evgeniya', 'leya'].includes(per)) per = 'anatoly';
const vmode = () => tab === 'vox' ? { v: vm, p: per } : {};
const vStat = () => sendJ({ type: 'vstat', p: per });
function vDraw() {
  document.body.classList.toggle('vox', tab === 'vox');
  for (const [id, k, v] of [['tabs', 't', tab], ['ppl', 'p', per], ['vmode', 'v', vm]])
    for (const b of $(id).children) b.classList.toggle('on', b.dataset[k] === v);
  set('phrase', vm === 'rec' ? '«' + PH[phi % PH.length] + '»' : 'Скажите что угодно — проверю, кто это');
}
const pick = (id, k, f) => { $(id).onclick = e => { const x = e.target.dataset[k]; if (x) { f(x); vDraw(); } }; };
pick('tabs', 't', x => { tab = x; vStat(); });
pick('ppl', 'p', x => { per = x; localStorage.setItem('voice.p', x); set('vcnt', '…'); vStat(); });
pick('vmode', 'v', x => { vm = x; });
$('vdel').onclick = () => confirm('Удалить последний образец?') && sendJ({ type: 'vdel', p: per });
$('vdelall').onclick = () => confirm('Удалить ВСЕ образцы этого человека?') && sendJ({ type: 'vdelall', p: per });
$('vplay').onclick = () => {
  const a = $('vaudio');
  a.src = 'api/voices/' + per + '/last.wav?t=' + Date.now(); a.play().catch(() => flash('Образцов нет', 1));
};
function vMsg(m) {
  if (m.type === 'who') set('who', m.who + (m.pct ? ' (' + m.pct + ' %)' : '') + (m.err ? ' · ' + m.err : ''));
  if (m.type === 'vstat' && m.p === per) set('vcnt', 'Записано ' + m.n + ' из 15–20');
  if (m.type === 'vstat' && m.ok) { phi++; vDraw(); flash('Образец сохранён'); }
  if (m.type === 'vshort') flash('Тихо или мало речи (' + m.sec + ' с) — прочитайте фразу целиком', 1);
  if (m.type === 'vcheck') {
    flash('Говорит: ' + m.who + (m.pct ? ' (' + m.pct + ' %)' : ''));
    set('vres', Object.entries(m.sims).map(([k, v]) => k + ': ' + v.toFixed(2)).join(' · ') + ' · ' + m.ms + ' мс');
  }
  if (m.type === 'verr') flash('Ошибка: ' + m.text, 1);
}
vDraw();
