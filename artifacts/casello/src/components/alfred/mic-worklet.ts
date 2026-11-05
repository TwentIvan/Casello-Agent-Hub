/** Sorgente dell'AudioWorklet del microfono: ricampiona a 16 kHz, PCM 16 bit, pacchetti da 100 ms. */
export const MIC_WORKLET_SOURCE = `
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.buf = []; }
  process(inputs) {
    const ch = inputs[0][0]; if (!ch) return true;
    while (this.pos < ch.length) { this.buf.push(ch[Math.floor(this.pos)]); this.pos += this.ratio; }
    this.pos -= ch.length;
    if (this.buf.length >= 1600) {
      const pcm = new Int16Array(this.buf.length);
      for (let i = 0; i < pcm.length; i++) { const v = Math.max(-1, Math.min(1, this.buf[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      this.port.postMessage(pcm.buffer, [pcm.buffer]); this.buf = [];
    }
    return true;
  }
}
registerProcessor("mic", Mic);`;
