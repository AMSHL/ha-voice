// Mic -> 16 kHz int16, 20 ms frames (box-filter resample).
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.r = sampleRate / 16000; this.t = 0; this.acc = 0; this.n = 0;
    this.buf = new Int16Array(320); this.i = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.n++;
      if (++this.t < this.r) continue;
      this.t -= this.r;
      const v = Math.max(-1, Math.min(1, this.acc / this.n));
      this.acc = 0; this.n = 0;
      this.buf[this.i++] = v * 32767;
      if (this.i === 320) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(320); this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16k);
