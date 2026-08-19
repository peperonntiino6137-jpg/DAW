'use strict';

// 3バンド パラメトリック/ダイナミックEQ
//
// 各バンド: 周波数・ゲイン・Q（パラメトリック）+ ダイナミック量・しきい値（ダイナミック）。
// ダイナミック量 0 なら純粋なパラメトリックEQ。負値 = 帯域が大きいほどカット
// （ディエッサー/共鳴つぶし）、正値 = 大きいほどブースト。
//
// DSP は AudioWorklet で自前実装（ピーキングバイカッド + 帯域検出エンベロープ）。
// モジュールは Blob URL 経由でロードするので file:// でも動く。
// AudioWorklet のロードは非同期のため prepare() フックを使う（core が
// play / 書き出し / 読み込み / FX追加 の前に await する）。
(() => {
  const PROCESSOR = `
class DynEQ3 extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options.processorOptions || {};
    this.fs = sampleRate;
    this.bands = [0, 1, 2].map(i => ({
      freq: p['f' + (i + 1)], q: p['q' + (i + 1)], gain: p['g' + (i + 1)],
      dyn: p['d' + (i + 1)], thresh: p['t' + (i + 1)],
      curGain: p['g' + (i + 1)],
      b0: 1, b1: 0, b2: 0, a1: 0, a2: 0,
      st: [],
      db0: 0, db2: 0, da1: 0, da2: 0, dx1: 0, dx2: 0, dy1: 0, dy2: 0,
      env: 0,
    }));
    for (const b of this.bands) { this.calcDetector(b); this.calcMain(b, b.curGain); }
    this.attC = Math.exp(-1 / (0.005 * this.fs));
    this.relC = Math.exp(-1 / (0.08 * this.fs));
    this.port.onmessage = e => {
      const key = e.data.key, value = e.data.value;
      const b = this.bands[+key.slice(1) - 1];
      if (!b) return;
      const k = key[0];
      if (k === 'f') { b.freq = value; this.calcDetector(b); this.calcMain(b, b.curGain); }
      else if (k === 'q') { b.q = value; this.calcDetector(b); this.calcMain(b, b.curGain); }
      else if (k === 'g') b.gain = value;
      else if (k === 'd') b.dyn = value;
      else if (k === 't') b.thresh = value;
    };
  }
  calcMain(b, gdB) {
    const A = Math.pow(10, gdB / 40);
    const w = 2 * Math.PI * Math.min(b.freq, this.fs * 0.45) / this.fs;
    const al = Math.sin(w) / (2 * Math.max(0.1, b.q));
    const cw = Math.cos(w);
    const a0 = 1 + al / A;
    b.b0 = (1 + al * A) / a0; b.b1 = -2 * cw / a0; b.b2 = (1 - al * A) / a0;
    b.a1 = -2 * cw / a0; b.a2 = (1 - al / A) / a0;
  }
  calcDetector(b) {
    const w = 2 * Math.PI * Math.min(b.freq, this.fs * 0.45) / this.fs;
    const al = Math.sin(w) / (2 * Math.max(0.1, b.q));
    const cw = Math.cos(w);
    const a0 = 1 + al;
    b.db0 = al / a0; b.db2 = -al / a0; b.da1 = -2 * cw / a0; b.da2 = (1 - al) / a0;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || inp.length === 0) return true;
    const n = inp[0].length;
    for (const b of this.bands) {
      const x = inp[0];
      let dx1 = b.dx1, dx2 = b.dx2, dy1 = b.dy1, dy2 = b.dy2, env = b.env;
      for (let i = 0; i < n; i++) {
        const xi = x[i];
        const y = b.db0 * xi + b.db2 * dx2 - b.da1 * dy1 - b.da2 * dy2;
        dx2 = dx1; dx1 = xi; dy2 = dy1; dy1 = y;
        const e = y < 0 ? -y : y;
        env = e > env ? this.attC * env + (1 - this.attC) * e
                      : this.relC * env + (1 - this.relC) * e;
      }
      b.dx1 = dx1; b.dx2 = dx2; b.dy1 = dy1; b.dy2 = dy2; b.env = env;
      const lvl = 20 * Math.log10(env + 1e-7);
      const over = Math.max(0, lvl - b.thresh);
      const target = b.gain + b.dyn * Math.min(1, over / 12);
      const ng = b.curGain + (target - b.curGain) * 0.3;
      if (Math.abs(ng - b.curGain) > 0.01) { b.curGain = ng; this.calcMain(b, ng); }
    }
    for (let ch = 0; ch < inp.length; ch++) {
      const x = inp[ch], y = out[ch];
      if (!y) continue;
      y.set(x);
      for (const b of this.bands) {
        let s = b.st[ch];
        if (!s) s = b.st[ch] = [0, 0, 0, 0];
        let x1 = s[0], x2 = s[1], y1 = s[2], y2 = s[3];
        for (let i = 0; i < n; i++) {
          const xi = y[i];
          const yo = b.b0 * xi + b.b1 * x1 + b.b2 * x2 - b.a1 * y1 - b.a2 * y2;
          x2 = x1; x1 = xi; y2 = y1; y1 = yo;
          y[i] = yo;
        }
        s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2;
      }
    }
    return true;
  }
}
registerProcessor('dyn-eq3', DynEQ3);
`;

  const loading = new WeakMap(); // ctx -> Promise
  const ready = new WeakSet();   // モジュールロード済みの ctx

  function bandParams(i, jp, fMin, fMax, fDef) {
    return [
      { key: 'f' + i, label: jp + ':周波数', min: fMin, max: fMax, step: 1, default: fDef },
      { key: 'g' + i, label: jp + ':ゲイン', min: -15, max: 15, step: 0.5, default: 0 },
      { key: 'q' + i, label: jp + ':Q', min: 0.3, max: 8, step: 0.1, default: 1 },
      { key: 'd' + i, label: jp + ':ﾀﾞｲﾅﾐｯｸ', min: -15, max: 15, step: 0.5, default: 0 },
      { key: 't' + i, label: jp + ':しきい値', min: -60, max: 0, step: 1, default: -30 },
    ];
  }

  DAW.plugins.register({
    id: 'dyneq3',
    name: 'ダイナミックEQ',
    params: [].concat(bandParams(1, '低', 20, 1000, 120),
                      bandParams(2, '中', 200, 8000, 1000),
                      bandParams(3, '高', 1000, 18000, 6000)),

    prepare(ctx) {
      if (ready.has(ctx)) return Promise.resolve();
      let p = loading.get(ctx);
      if (!p) {
        const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }));
        p = ctx.audioWorklet.addModule(url).then(() => {
          ready.add(ctx);
          URL.revokeObjectURL(url);
        });
        loading.set(ctx, p);
      }
      return p;
    },

    create(ctx, params) {
      if (!ready.has(ctx)) {
        // モジュール未ロード（prepare前）ならパススルーで安全に動かす
        const g = ctx.createGain();
        return { input: g, output: g, set() {} };
      }
      const node = new AudioWorkletNode(ctx, 'dyn-eq3', {
        processorOptions: Object.assign({}, params),
      });
      return {
        input: node,
        output: node,
        set(key, value) { node.port.postMessage({ key, value }); },
      };
    },
  });
})();
