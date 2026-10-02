// Voice 2a: mic -> 16 kHz int16, 20 ms frames -> WebSocket; answer audio back -> Web Audio.
const $ = id => document.getElementById(id);
const set = (id, t) => { $(id).textContent = t; };
const PRE = 15, MIN_HOLD = 400; // 15 frames = 0.3 s pre-roll
let room = localStorage.getItem('voice.room');
if (!['bedroom', 'living', 'kids'].includes(room)) room = 'bedroom';
let listening = false, ptt = null, ws = null, ok = false, retry = 1000;
let pre = [], ctx = null, pong = 0, stT = 0, lvlT = 0, peak = -100;

function status(t, err) { $('status').textContent = t; $('status').className = err ? 'err' : ''; }
function idle() { status(ptt ? 'Говорите…' : listening ? 'Слушаю' : 'Ожидание'); }
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
  if (ptt) { ptt = null; sayUi(false); flash('Ошибка: связь пропала', 1); }
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
  if (m.type === 'nosat') flash('Home Assistant не подключён к спутнику ' + m.room, 1);
  if (m.type === 'sent') { clearTimeout(stT); status('Распознаю…'); stT = setTimeout(idle, 15000); set('heard', '…'); set('answer', '…'); }
  if (m.type === 'heard') set('heard', m.text || '(ничего не распознано)');
  if (m.type === 'answer') set('answer', m.text || '—');
  if (m.type === 'tts') { fmt = m; clearTimeout(stT); status('Отвечаю…'); stT = setTimeout(idle, 15000); }
  if (m.type === 'ttsend') { clearTimeout(stT); stT = setTimeout(idle, Math.max(0, playT - (ctx ? ctx.currentTime : 0)) * 1000); }
  if (m.type === 'perr') { flash('Ошибка: ' + m.text, 1); set('answer', 'Ошибка: ' + m.text); }
  if (m.type === 'hello') set('ver', 'v' + m.version);
  if (m.type === 'pong') { pong = performance.now(); set('dRtt', Math.round(pong - m.t) + ' мс'); set('dSat', m.sat ? 'подключён' : 'не подключён'); }
  if (m.type === 'level') set('lvlSrv', m.db + ' дБ');
  if (m.type === 'saved') { flash('Отправлено: ' + m.sec + ' с'); loadRec(); }
  if (m.type === 'short') flash('Слишком коротко');
}

$('start').onclick = async () => {
  set('dMic', 'запрашиваю…');
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.audioWorklet.addModule('worklet.js');
    const node = new AudioWorkletNode(ctx, 'pcm16k'), mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(st).connect(node).connect(mute).connect(ctx.destination);
    node.port.onmessage = e => onFrame(e.data);
    await ctx.resume();
    st.getAudioTracks()[0].onended = () => { set('dMic', 'отключён'); status('Ошибка: микрофон отключён', 1); };
    set('dMic', 'разрешён'); set('dRate', ctx.sampleRate + ' → 16000 Гц');
    $('start').hidden = true; idle(); wake();
  } catch (e) {
    set('dMic', 'ошибка: ' + (e.name || e));
    status('Ошибка: ' + (e.name === 'NotAllowedError' ? 'нет доступа к микрофону' : e.message || e), 1);
  }
};

function onFrame(buf) {
  const a = new Int16Array(buf);
  let sq = 0;
  for (const v of a) sq += v * v;
  peak = Math.max(peak, 10 * Math.log10(sq / a.length / 2 ** 30 + 1e-10));
  if (performance.now() - lvlT > 100) {
    $('lvl').style.width = Math.max(0, Math.min(100, (peak + 60) * 5 / 3)) + '%';
    set('lvlMic', Math.round(peak) + ' дБ'); peak = -100; lvlT = performance.now();
  }
  if (ptt || listening) sendB(buf);
  pre.push(buf); if (pre.length > PRE) pre.shift();
}

const listen = $('listen'), say = $('say');
listen.onclick = () => {
  if (!ctx) return flash('Сначала включите микрофон', 1);
  listening = !listening;
  listen.classList.toggle('on', listening);
  listen.lastChild.textContent = listening ? 'поток идёт' : 'выключено';
  sendJ(mode()); idle();
};

function sayUi(on) {
  say.classList.toggle('down', on); say.classList.remove('out');
  say.lastChild.textContent = on ? 'отпустите — отправить' : 'держите и говорите';
}
say.oncontextmenu = e => e.preventDefault();
say.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
say.onpointerdown = e => {
  if (ptt) return;
  if (!ctx) return flash('Сначала включите микрофон', 1);
  if (!ok) return flash('Ошибка: нет связи', 1);
  say.setPointerCapture(e.pointerId);
  ptt = { t: performance.now(), id: e.pointerId, out: false };
  sendJ({ type: 'start', room });
  pre.forEach(b => sendB(b));
  sayUi(true); idle();
};
say.onpointermove = e => {
  if (!ptt || e.pointerId !== ptt.id) return;
  const r = say.getBoundingClientRect();
  ptt.out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  say.classList.toggle('out', ptt.out);
  status(ptt.out ? 'Отпустите — отмена' : 'Говорите…');
};
function release(e, cancel) {
  if (!ptt || e.pointerId !== ptt.id) return;
  const held = performance.now() - ptt.t, out = ptt.out;
  ptt = null; sayUi(false);
  if (cancel || out || held < MIN_HOLD) {
    sendJ({ type: 'cancel' }); flash(cancel || out ? 'Отменено' : 'Промах: держите дольше');
  } else { sendJ({ type: 'end' }); status('Отправляю…'); }
}
say.onpointerup = e => release(e, false);
say.onpointercancel = e => release(e, true);

async function wake() {
  try {
    const l = await navigator.wakeLock.request('screen');
    set('dWake', 'не гаснет'); l.onrelease = () => set('dWake', 'может погаснуть');
  } catch (e) { set('dWake', 'Wake Lock нет: ' + e.name); }
}
document.onvisibilitychange = () => {
  if (document.hidden) return;
  if (ctx) ctx.resume();
  wake();
};
document.addEventListener('touchend', () => ctx && ctx.state !== 'running' && ctx.resume());

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
