'use strict';

// マスターリミッター（先読み型）。
//
// 先読み（lookahead）があるので、ピークが出力に到達する前にゲインを下げきれる。
// そのため「シーリングを超えるサンプルが1つも出ない」ことを保証できる。
//
// 保証の作り方:
//   1. 入力サンプルごとに必要ゲイン r[n] = min(1, ceiling / |x[n]|) を求める
//   2. 直近 L+1 サンプルの r の **最小値** を単調デックで求める（O(1) 償却）
//   3. 出力は L サンプル遅れた x[n-L] に、その最小値を掛けたもの
//      → 掛けるゲインは必ず r[n-L] 以下なので |y| <= ceiling が成り立つ
//   4. リリースは「戻すとき（ゲインが上がる方向）」だけ緩やかにする。
//      上がる方を遅らせても保証は壊れない（常に必要ゲイン以下に留まるため）
//
// 実行場所が2つある:
//   ライブ   … AudioWorklet（リアルタイムなので他に選択肢がない）
//   書き出し … レンダリング済みバッファに対してメインスレッドで適用
//
// **書き出しで AudioWorklet を使わないのは意図的**。ライブの Worklet が生きている状態で
// HRTF を含むオフラインレンダリングを走らせると、レンダリングが極端に遅くなる現象を実測した
// （8秒でも終わらず、テストのウォッチドッグに引っかかるほど）。書き出しにリアルタイム制約は
// 無いので、同じ DSP を JS で流せば済む。
//
// DSP 本体は coreSource() に1か所だけ持ち、Worklet とメインスレッドの両方がそれを使う。
// 実装が2つに分かれると「聞いた音と書き出した音が違う」という最悪の不具合になるため。
DAW.limiter = {
  enabled: true,
  params: {
    gainDb: 0,        // 入力ゲイン
    releaseMs: 100,   // リリース
    ceilingDb: -1,    // 出力シーリング（このレベルを超えるサンプルは出さない）
    lookaheadMs: 5,   // 先読み
  },
  LIMITS: {
    gainDb: [-24, 24],
    releaseMs: [1, 1000],
    ceilingDb: [-24, 0],
    lookaheadMs: [0, 20],
  },
  DEFAULTS: { gainDb: 0, releaseMs: 100, ceilingDb: -1, lookaheadMs: 5 },
  modUrl: null,
  node: null,        // ライブ用の AudioWorkletNode
  _Core: null,

  clamp(key, v) {
    const r = this.LIMITS[key];
    const n = +v;
    if (!isFinite(n)) return this.params[key];
    return Math.max(r[0], Math.min(r[1], n));
  },

  set(key, value) {
    if (!this.LIMITS[key]) return false;
    this.params[key] = this.clamp(key, value);
    if (this.node) this.node.port.postMessage({ type: 'params', params: this.params });
    return true;
  },

  setEnabled(on) {
    this.enabled = !!on;
    if (this.node) this.node.port.postMessage({ type: 'bypass', bypass: !this.enabled });
  },

  // 保存/履歴スナップショット用のプレーンな状態（params はコピーして固定する）
  toJSON() {
    return { enabled: this.enabled, params: Object.assign({}, this.params) };
  },

  // プロジェクト読み込み/履歴復元用。欠落や不正値は既定値で補完する
  // （旧プロジェクトは従来どおり「有効・既定パラメータ」で開く）。
  load(src) {
    const s = src && typeof src === 'object' ? src : {};
    const p = s.params && typeof s.params === 'object' ? s.params : {};
    for (const key of Object.keys(this.LIMITS)) {
      const v = +p[key];
      this.set(key, p[key] != null && isFinite(v) ? v : this.DEFAULTS[key]);
    }
    this.setEnabled(s.enabled != null ? !!s.enabled : true);
  },

  // 出力の遅延（秒）。書き出しの整列と、再生ヘッド表示の補正に使う。
  latencySec() {
    return this.enabled ? this.params.lookaheadMs / 1000 : 0;
  },

  ceilingLinear() {
    return Math.pow(10, this.params.ceilingDb / 20);
  },

  // ---- DSP 本体（Worklet とメインスレッドで共有する唯一の実装） ----
  coreSource() {
    return `
class DawLimiterCore {
  constructor(sampleRate, params) {
    this.sr = sampleRate;
    this.buf = null;
    this.setParams(params || {});
  }

  setParams(p) {
    this.gain = Math.pow(10, (p.gainDb || 0) / 20);
    this.ceiling = Math.pow(10, (p.ceilingDb == null ? -1 : p.ceilingDb) / 20);
    this.releaseMs = p.releaseMs || 100;
    const look = Math.max(0, Math.round((p.lookaheadMs || 0) / 1000 * this.sr));
    if (look !== this.look || !this.buf) {
      this.look = look;
      this.size = look + 1;
      this.buf = null;                          // 遅延線はチャンネル数が分かってから作る
      this.dq = new Float32Array(this.size);    // 単調デック（必要ゲインの値）
      this.dqIdx = new Int32Array(this.size);   // 同（サンプル位置）
    }
    this.rel = Math.exp(-1 / (Math.max(1, this.releaseMs) / 1000 * this.sr));
  }

  ensureBuffers(nch) {
    if (this.buf && this.buf.length === nch) return;
    this.buf = Array.from({ length: nch }, () => new Float32Array(Math.max(1, this.size)));
    this.pos = 0;
    this.head = 0;
    this.tail = 0;
    this.n = 0;
    this.env = 1;
  }

  // input / output は Float32Array の配列。frames サンプルぶん処理する。
  process(input, output, frames) {
    const nch = Math.min(input.length, output.length);
    if (!nch) return;
    this.ensureBuffers(nch);
    const size = Math.max(1, this.size);
    for (let i = 0; i < frames; i++) {
      // 全チャンネルの最大絶対値を見る（L/R をリンクさせて定位を崩さない）
      let peak = 0;
      for (let c = 0; c < nch; c++) {
        const v = input[c][i] * this.gain;
        this.buf[c][this.pos] = v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      const req = peak > this.ceiling ? this.ceiling / peak : 1;

      // 直近 size サンプルの必要ゲインの最小値（単調デックで O(1) 償却）
      while (this.tail > this.head && this.dq[(this.tail - 1) % size] >= req) this.tail--;
      this.dq[this.tail % size] = req;
      this.dqIdx[this.tail % size] = this.n;
      this.tail++;
      while (this.dqIdx[this.head % size] <= this.n - size) this.head++;
      const target = this.dq[this.head % size];

      // 下げるのは即座（先読みしているので歪まない）、戻すのはリリース時定数で緩やかに
      if (target < this.env) this.env = target;
      else this.env = target + (this.env - target) * this.rel;

      const readPos = (this.pos + 1) % size;   // look サンプル前の位置
      for (let c = 0; c < nch; c++) output[c][i] = this.buf[c][readPos] * this.env;
      this.pos = readPos;
      this.n++;
    }
  }
}
`;
  },

  moduleSource() {
    return this.coreSource() + `
class DawLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options.processorOptions || {}).params || {};
    this.bypass = false;
    this.core = new DawLimiterCore(sampleRate, p);
    this.port.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'params') this.core.setParams(d.params);
      else if (d.type === 'bypass') this.bypass = !!d.bypass;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    if (this.bypass) {
      for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      return true;
    }
    this.core.process(input, output, input[0].length);
    for (let c = input.length; c < output.length; c++) output[c].fill(0);
    return true;
  }
}
registerProcessor('daw-limiter', DawLimiter);
`;
  },

  // メインスレッド側で同じ DSP クラスを得る（Worklet と同一のソースから作る）
  Core() {
    if (!this._Core) this._Core = new Function(this.coreSource() + '\nreturn DawLimiterCore;')();
    return this._Core;
  },

  // AudioWorklet は ctx ごとに addModule が必要。ライブ用。
  // blob: URL は file:// で開くと AbortError になる（Chrome の制限）ので data: URL を使う。
  async prepare(ctx) {
    if (!this.modUrl) {
      this.modUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(this.moduleSource());
    }
    await ctx.audioWorklet.addModule(this.modUrl);
  },

  create(ctx) {
    const node = new AudioWorkletNode(ctx, 'daw-limiter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { params: this.params },
    });
    node.port.postMessage({ type: 'bypass', bypass: !this.enabled });
    return node;
  },

  // レンダリング済みバッファへ適用する（書き出し用）。
  // 出力は先読みぶん遅れるので、呼び出し側で頭を捨てて整列させること。
  processBuffer(buffer, params) {
    const core = new (this.Core())(buffer.sampleRate, params || this.params);
    const nch = buffer.numberOfChannels;
    const input = [];
    const output = [];
    for (let c = 0; c < nch; c++) {
      input.push(buffer.getChannelData(c));
      output.push(new Float32Array(buffer.length));
    }
    core.process(input, output, buffer.length);
    return {
      numberOfChannels: nch,
      sampleRate: buffer.sampleRate,
      length: buffer.length,
      duration: buffer.length / buffer.sampleRate,
      getChannelData: c => output[c],
    };
  },
};
