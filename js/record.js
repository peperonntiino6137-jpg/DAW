'use strict';

// マイク録音。
//
// MediaRecorder（webm 圧縮 → 再デコード）ではなく AudioWorklet で生 PCM を受け取る。
// 理由: 圧縮往復による劣化と、エンコーダ起動分の頭ズレを避けられるため。
// Worklet モジュールは Blob URL で読むので file:// でも動く（dyneq.js と同じ手口）。
//
// 録音は「テイクごとに新しいトラックを作る」方式。既存トラックの再生は同時に走るので、
// 聞きながら重ね録り（オーバーダブ）できる。
DAW.record = {
  CHUNK: 4096,        // Worklet 側でまとめて送るフレーム数
  active: false,
  stream: null,
  node: null,
  source: null,
  sink: null,
  chunks: null,       // [ch][] の Float32Array 配列
  numCh: 1,
  startPos: 0,        // 録音を始めたタイムライン位置（秒）
  modUrl: null,

  moduleSource() {
    return `
class DawRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = (options.processorOptions || {}).chunk || 4096;
    this.buf = null;
    this.fill = 0;
    // 停止時に端数フレームを取りこぼさないための吐き出し要求
    this.port.onmessage = e => {
      if (e.data !== 'flush') return;
      if (this.buf && this.fill > 0) this.port.postMessage(this.buf.map(b => b.slice(0, this.fill)));
      this.fill = 0;
      this.port.postMessage('flushed');
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const nch = input.length;
    if (!this.buf || this.buf.length !== nch) {
      this.buf = Array.from({ length: nch }, () => new Float32Array(this.size));
      this.fill = 0;
    }
    let read = 0;
    const n = input[0].length;
    while (read < n) {
      const take = Math.min(this.size - this.fill, n - read);
      for (let c = 0; c < nch; c++) this.buf[c].set(input[c].subarray(read, read + take), this.fill);
      this.fill += take;
      read += take;
      if (this.fill === this.size) {
        this.port.postMessage(this.buf.map(b => b.slice(0)));
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('daw-recorder', DawRecorder);
`;
  },

  async prepare(ctx) {
    if (!this.modUrl) this.modUrl = URL.createObjectURL(new Blob([this.moduleSource()], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(this.modUrl);
  },

  // 録音開始。成功したら true。マイクが使えなければ理由を出して false。
  async start() {
    if (this.active) return false;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // 音楽用途なので端末側の加工は全て切る
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      alert('マイクを使用できませんでした: ' + (e && e.name ? e.name : e));
      return false;
    }
    const ctx = DAW.audio.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    await this.prepare(ctx);

    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.numCh = Math.max(1, Math.min(2, this.source.channelCount || 1));
    this.node = new AudioWorkletNode(ctx, 'daw-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: this.numCh,
      processorOptions: { chunk: this.CHUNK },
    });
    this.chunks = Array.from({ length: this.numCh }, () => []);
    this.node.port.onmessage = e => {
      if (e.data === 'flushed') {
        if (this.onFlushed) this.onFlushed();
        return;
      }
      const data = e.data;
      for (let c = 0; c < this.chunks.length; c++) this.chunks[c].push(data[Math.min(c, data.length - 1)]);
    };
    // Worklet は出力が引かれないと動かないので、無音の吸い込み先へ繋ぐ（モニタ音は返さない）
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);

    const captureStartedAt = ctx.currentTime;   // 1フレーム目に対応する ctx 時刻
    this.active = true;
    if (!DAW.audio.playing) await DAW.audio.play();   // 既存トラックを聞きながら録れるように
    // 録音1フレーム目がタイムライン上のどこに当たるかを、再生の時間基準から逆算する。
    // play() は ctx.currentTime + 0.05 から鳴らし始めるので、そのぶん録音の方が先に始まっている。
    // これを無視すると、録れたテイクが既存トラックより 50ms 以上前へずれる。
    this.startPos = DAW.audio.playing
      ? DAW.audio.playStartPos + (captureStartedAt - DAW.audio.playStartCtxTime)
      : DAW.audio.getPos();
    return true;
  },

  // 録音停止。録れた音を新しいトラックのクリップとして追加し、そのトラックを返す。
  // Worklet 内に溜まっている端数フレーム（最大 CHUNK-1 = 約85ms）を吐き出させてから止める。
  async stop() {
    if (!this.active) return null;
    this.active = false;
    const flushed = new Promise(res => {
      this.onFlushed = res;
      setTimeout(res, 300);   // Worklet が応答しない場合の保険
    });
    this.node.port.postMessage('flush');
    await flushed;
    this.onFlushed = null;
    try { this.source.disconnect(); } catch (e) {}
    try { this.node.disconnect(); } catch (e) {}
    try { this.sink.disconnect(); } catch (e) {}
    for (const t of this.stream.getTracks()) t.stop();
    this.node.port.onmessage = null;

    const ctx = DAW.audio.ctx;
    const frames = this.chunks[0].reduce((n, c) => n + c.length, 0);
    this.stream = this.source = this.node = this.sink = null;
    if (frames === 0) return null;

    const buf = ctx.createBuffer(this.chunks.length, frames, ctx.sampleRate);
    for (let c = 0; c < this.chunks.length; c++) {
      const out = buf.getChannelData(c);
      let o = 0;
      for (const chunk of this.chunks[c]) { out.set(chunk, o); o += chunk.length; }
    }
    this.chunks = null;

    const bufferId = DAW.registerBuffer(buf);
    const n = DAW.project.tracks.filter(t => /^録音/.test(t.name)).length + 1;
    const track = DAW.addTrack(`録音 ${n}`);
    // startPos が負（再生開始前に録り始めた分）なら、その頭を offset で読み飛ばす
    const offset = Math.max(0, -this.startPos);
    const startTime = Math.max(0, this.startPos);
    const duration = buf.duration - offset;
    if (duration <= 0) return track;
    track.clips.push({
      id: DAW.uid(),
      bufferId,
      startTime,
      offset,
      duration,
      name: `テイク ${n}`,
      fadeIn: 0,
      fadeOut: 0,
    });
    return track;
  },
};
