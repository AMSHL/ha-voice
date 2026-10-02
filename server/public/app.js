// Voice 0.4: mic -> 16 kHz int16, 20 ms frames -> WebSocket; answer audio back -> Web Audio.
// Mic is open only while "Сказать" is held or "Слушать" is on; AudioContext stays for playback.
const $ = id => document.getElementById(id);
const set = (id, t) => { $(id).textContent = t; };
const PRE = 15, MIN_HOLD = 400; // 15 frames = 0.3 s pre-roll (only with "Слушать")
let room = localStorage.getItem('voice.room');
if (!['bedroom', 'living', 'kids'].includes(room)) room = 'bedroom';
let listening = false, ptt = null, ws = null, ok = false, retry = 1000;
let pre = [], ctx = null, mute = null, wl = null, mic = null, micP = null, pong = 0, stT = 0, lvlT = 0, peak = -100;

function status(t, err) { $('status').textContent = t; $('status').className = err ? 'err' : ''; }
// 0.4 «Слушать»: the server reports lstate wake -> cmd (wake word heard) -> busy -> wake again.
const LS = { wake: 'Жду «Hey Jarvis»', cmd: 'Слушаю команду…', busy: 'Думаю…', nosat: 'Жду, пока HA подключит спутник' };
let lst = '', hint = false, flT = 0;
function idle() {
  status(ptt ? (ptt.live ? 'Говорите…' : 'Готовлюсь…') : listening ? LS[lst] || 'Включаю…'
    : hint ? 'Слушать выключено, нажмите, чтобы включить' : 'Ожидание');
  $('status').parentNode.classList.toggle('hot', listening && lst === 'cmd');
}
function flash(t, err) { status(t, err); clearTimeout(stT); flT = performance.now() + (err ? 4000 : 2000); stT = setTimeout(idle, err ? 4000 : 2000); }
function beep() { // short tone made in Web Audio, no file
  if (!ctx || ctx.state !== 'running') return;
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
  o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.2);
}
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
// 0.3.3/0.4.1: answer in the rate from 'tts' (HA sends 22050), streamed into Web Audio, see ttsStart().
// iOS: navigator.audioSession 'playback' ignores the silent switch; 'play-and-record' only while the mic is open.
let fmt = null, chunks = [], last = null, S = null, tm = {};
function sess(t) {
  const a = navigator.audioSession;
  if (a && t) try { a.type = t; } catch (_) {}
  set('dAs', a ? a.type : 'нет API');
}
function dCtx() { set('dCtx', ctx ? 'AudioContext ' + ctx.state : 'ещё не было касания'); }
function dLast() { if (last) set('dLast', last.sec.toFixed(1) + ' с, проигран ' + (last.played ? 'да' : 'нет')); }
function tapUi(on) { $('tapPlay').hidden = !on; }
function tts(buf) { // int16 chunk of the answer, format from the last 'tts' message
  if (!fmt) return;
  const a = new Int16Array(buf, 0, buf.byteLength >> 1);
  chunks.push(a);
  if (S) { S.q.push(a); S.n += a.length; pump(S); }
}
const toBuf = (pcm, ch, rate) => {
  const n = Math.floor(pcm.length / ch), b = ctx.createBuffer(ch, n, rate);
  for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = pcm[i * ch + c] / 32768; }
  return b;
};
function join(list) {
  const pcm = new Int16Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { pcm.set(a, o); o += a.length; }
  return pcm;
}
// 0.4.1: the answer plays while it streams. AudioContext is resumed at 'tts' (at most 0.6 s);
// not running -> the old path: the whole answer at 'ttsend', else the "tap to hear" button.
function ttsStart(m) {
  fmt = m; chunks = []; tapUi(false);
  const s = S = { q: [], n: 0, t: 0, live: 0, ok: false, end: false, dead: false, done: false, first: false };
  if (!ctx || m.width !== 2) return;
  sess(mic ? 'play-and-record' : 'playback');
  const go = () => { dCtx(); if (S === s && !s.dead && ctx.state === 'running') { s.ok = true; pump(s); } };
  if (ctx.state === 'running') return go();
  Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 600))]).then(go, go);
}
function pump(s) { // first piece after 0.3 s is buffered, then pieces of >=0.1 s, back to back to the sample
  if (!s.ok || s.dead || !s.n) return;
  const ch = fmt.channels || 1, now = ctx.currentTime;
  if (!s.end && s.n / ch / fmt.rate < (s.t ? 0.1 : 0.3)) return;
  if (s.t < now + 0.02) s.t = now + 0.05; // start, or the queue ran dry: a short gap, never an overlap
  const src = ctx.createBufferSource(), pcm = join(s.q);
  s.q = []; s.n = 0;
  src.buffer = toBuf(pcm, ch, fmt.rate); src.connect(ctx.destination); src.start(s.t);
  if (!s.first) { s.first = true; sound((s.t - now + (ctx.outputLatency || 0)) * 1000); }
  s.t += pcm.length / ch / fmt.rate; s.live++;
  src.onended = () => { if (--s.live === 0 && s.end && !s.n) fin(s); };
}
function fin(s) {
  if (s.done || S !== s) return;
  s.done = true; sendJ({ type: 'played' }); if (listening) lst = 'wake'; idle();
}
function mark(m) { // 0.4.1: m.at = ms since the end of the phrase (server clock); 'tts' ties in the page clock
  const k = { who: 'who', heard: 'asr', answer: 'ag', tts: 'ag' }[m.type];
  if (k && tm[k] == null) tm[k] = m.at;
  if (m.type === 'tts') tm.base = performance.now() - m.at;
  dTm();
}
function sound(dt) { if (tm.snd == null && tm.base != null) { tm.snd = Math.round(performance.now() + dt - tm.base); dTm(); } }
function dTm() {
  const f = (t, k) => tm[k] == null ? '' : t + ' ' + tm[k];
  set('dTm', [f('опознание', 'who'), f('распознано', 'asr'), f('агент', 'ag'), f('звук', 'snd')].filter(Boolean).join(' → ') + ' мс');
}
function ttsDone() {
  const s = S, pcm = join(chunks), ch = fmt && fmt.channels || 1;
  chunks = [];
  if (!fmt || fmt.width !== 2 || !pcm.length) { if (s) s.dead = true; sendJ({ type: 'played' }); return idle(); }
  last = { pcm, ch, rate: fmt.rate, sec: pcm.length / ch / fmt.rate, played: !!(s && s.ok) };
  dLast();
  if (s && s.ok) { s.end = true; pump(s); if (!s.live) fin(s); return; }
  if (s) s.dead = true;
  play();
}
function play() { // also called from the "tap to hear" button, inside its gesture
  const L = last;
  if (!L || L.played) return;
  sess(mic ? 'play-and-record' : 'playback');
  const ask = () => { sendJ({ type: 'played' }); tapUi(true); clearTimeout(stT); status('Нажмите, чтобы услышать ответ'); };
  if (!ctx) return ask();
  const go = () => {
    dCtx();
    if (L !== last || L.played) return;
    if (ctx.state !== 'running') return ask();
    const s = ctx.createBufferSource(); s.buffer = toBuf(L.pcm, L.ch, L.rate); s.connect(ctx.destination); sound(0);
    s.onended = () => { sendJ({ type: 'played' }); if (listening) lst = 'wake'; idle(); }; s.start();
    L.played = true; tapUi(false); dLast(); clearTimeout(stT); status('Отвечаю…');
  };
  if (ctx.state === 'running') return go();
  // Outside a gesture iOS may leave resume() pending forever, so wait at most 0.6 s.
  Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 600))]).then(go, go);
}
function onMsg(m) {
  if (m.at != null) mark(m);
  if (m.type[0] === 'v' || m.type === 'who') return vMsg(m);
  if (m.type === 'nosat') flash('Home Assistant не подключён к спутнику ' + m.room, 1);
  if (m.type === 'sent') { clearTimeout(stT); status('Думаю…'); stT = setTimeout(idle, 15000); set('heard', '…'); set('answer', '…'); tapUi(false); fmt = null; chunks = []; S = null; }
  if (m.type === 'heard') set('heard', m.text || '(ничего не распознано)');
  if (m.type === 'answer') set('answer', m.text || '—');
  if (m.type === 'tts') { ttsStart(m); clearTimeout(stT); status('Отвечаю…'); stT = setTimeout(idle, 15000); }
  if (m.type === 'ttsend') ttsDone();
  if (m.type === 'lstate' && listening) {
    lst = m.s === 'none' ? 'wake' : m.s;
    if (m.s === 'cmd') beep();
    if (m.s === 'none') flash('Не расслышал команду');
    else if (m.s !== 'wake' || performance.now() > flT) { clearTimeout(stT); idle(); }
  }
  if (m.type === 'lost') { clearTimeout(stT); idle(); flash(m.text, 1); set('answer', m.text); }  // 0.4.2 watchdog
  if (m.type === 'perr') { flash('Ошибка: ' + m.text, 1); set('answer', 'Ошибка: ' + m.text); }
  if (m.type === 'hello') set('ver', 'v' + m.version);
  if (m.type === 'pong') { pong = performance.now(); set('dRtt', Math.round(pong - m.t) + ' мс'); set('dSat', m.sat ? 'подключён' : 'не подключён'); }
  if (m.type === 'level' && mic) set('lvlSrv', m.db + ' дБ');
  if (m.type === 'saved') { tm = {}; set('dTm', '…'); flash('Отправлено: ' + m.sec + ' с'); loadRec(); }
  if (m.type === 'short') flash('Слишком коротко');
}

// Called synchronously inside a tap: iOS lets an AudioContext start only from a gesture.
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    mute = ctx.createGain(); mute.gain.value = 0; mute.connect(ctx.destination);
    ctx.onstatechange = dCtx;
    wl = ctx.audioWorklet.addModule('worklet.js');
    wake();
  }
  if (ctx.state !== 'running') ctx.resume();
  // A silent 1-sample buffer inside the gesture unlocks iOS output for later answers.
  const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start();
  dCtx();
}
const wantMic = () => listening || !!ptt;
function openMic() {
  if (mic) return Promise.resolve(mic);
  return micP || (micP = (async () => {
    set('dMic', 'открываю…'); sess('play-and-record');
    let st = null;
    try {
      st = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      await wl;
      if (!wantMic()) { st.getTracks().forEach(t => t.stop()); set('dMic', 'выключен'); sess('playback'); return null; }
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
  m.src.disconnect(); m.node.disconnect(); sess('playback');
  set('dMic', 'выключен'); set('lvlMic', 'выключен'); set('lvlSrv', '—'); $('lvl').style.width = '0';
}
function micErr(e) {
  set('dMic', 'ошибка: ' + (e.name || e)); sess('playback');
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
  listening = on; lst = ''; if (on) hint = false;
  listen.classList.toggle('on', on);
  listen.lastChild.textContent = on ? (mic ? 'поток идёт' : 'включаю…') : hint ? 'нажмите, чтобы включить' : 'выключено';
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
  if (listening) { hint = true; setListen(false); }
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
const wtxt = m => m.who + (m.pct ? ' (' + m.pct + ' %)' : m.best ? ' (ближе всех ' + m.best + ', ' + m.conf + ' %)' : '');
function vMsg(m) {
  if (m.type === 'who') set('who', wtxt(m) + (m.err ? ' · ' + m.err : ''));
  if (m.type === 'vstat' && m.p === per) set('vcnt', 'Записано ' + m.n + ' из 15–20');
  if (m.type === 'vstat' && m.ok) { phi++; vDraw(); flash('Образец сохранён'); }
  if (m.type === 'vshort') flash('Тихо или мало речи (' + m.sec + ' с) — прочитайте фразу целиком', 1);
  if (m.type === 'vcheck') {
    flash('Говорит: ' + wtxt(m));
    set('vres', Object.entries(m.sims).map(([k, v]) => k + ': ' + v.toFixed(2)).join(' · ') + ' · ' + m.ms + ' мс');
  }
  if (m.type === 'verr') flash('Ошибка: ' + m.text, 1);
}
vDraw();

// 0.3.3: any tap on the page creates/resumes the AudioContext, so the answer can play later.
document.addEventListener('pointerdown', ensureCtx, true);
document.addEventListener('click', ensureCtx, true);
$('tapPlay').onclick = () => { ensureCtx(); play(); };
sess('playback'); dCtx();
// 0.4: after the tab was hidden «Слушать» is off; the hint in the status turns it back on with a tap.
$('status').onclick = () => { if (hint && !listening) listen.onclick(); };
