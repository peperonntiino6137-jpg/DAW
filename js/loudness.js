'use strict';

// ラウドネス計測（ITU-R BS.1770-4）。
//
// 実装しているもの:
//   - K特性フィルタ（2段 biquad）… 係数は**サンプルレートから毎回計算する**。
//     仕様書の表は 48kHz 専用なので、プリワープしたアナログ原型
//     （シェルフ: f0=1681.97Hz / G=+4dB / Q=0.7072、ハイパス: f0=38.14Hz / Q=0.5003）
//     から双一次変換で求める。48kHz ではこの式が仕様書 Table 1/2 の係数と
//     小数15桁まで一致する（テスト [43] で照合している）。
//   - 400ms ブロック・75% オーバーラップ（= 100ms ホップ）のゲーティングブロック
//   - Momentary(400ms) / Short Term(3s) / Integrated（絶対 -70 LUFS +
//     相対 -10 LU の2段ゲート）
//   - True Peak … 4倍オーバーサンプリング（窓関数付き sinc の 48 タップ
//     ポリフェーズ FIR）。サンプル点の間に隠れたピークを検出する
//
// 実行場所が2つある（js/limiter.js と同じ構図）:
//   ライブ   … AudioWorklet（masterGain 直後 = リミッター前のタップ）
//   書き出し … レンダリング済みバッファへメインスレッドで純関数として適用
//
// DSP 本体は coreSource() の1か所だけに持ち、Worklet もメインスレッドも
// そこから生成する。実装が割れると「見えている値と書き出しレポートが違う」
// という最悪の不具合になるため（リミッターと同じ理由）。
DAW.loudness = {
  // ライブ計測の最新値。AudioWorklet から 100ms ごとに届く。
  // METERING タブはこれを 30fps で読むだけ（rAF 側は計算しない）。
  live: { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeak: 0, truePeakDb: -Infinity },

  node: null,        // ライブ用の AudioWorkletNode（METERING タブを開いたときだけ作る）
  modUrl: null,
  _Core: null,
  _pending: null,    // attach の多重呼び出しガード
  _failed: false,    // Worklet が使えない環境では二度と試さない（再生は止めない）

  // チャンネル重み（BS.1770-4 Table 3）。サラウンド（|方位| 60〜120°の水平層）は
  // 1.41、LFE は計測から除外（0）。この DAW の書き出しチャンネル順
  // （js/objui.js の LAYOUTS）に合わせて持つ:
  //   2ch      = L R
  //   6ch      = L R C LFE Ls(110°) Rs(110°)
  //   12ch     = L R C LFE Lss(90°) Rss(90°) Lrs(135°) Rrs(135°) Ltf Rtf Ltr Rtr
  //   （135° と上層は 60〜120°の水平層に入らないので 1.0）
  weightsFor(nch) {
    if (nch === 6) return [1, 1, 1, 0, 1.41, 1.41];
    if (nch === 12) return [1, 1, 1, 0, 1.41, 1.41, 1, 1, 1, 1, 1, 1];
    const w = new Array(nch);
    w.fill(1);
    return w;
  },

  // ---- DSP 本体（Worklet とメインスレッドで共有する唯一の実装） ----
  coreSource() {
    return `
class DawLoudnessCore {
  // K特性フィルタの係数。仕様書の 48kHz 表を任意レートへ一般化する
  // （プリワープしたアナログ原型 -> 双一次変換。48kHz で表と一致することはテストで照合）。
  static kCoeffs(sr) {
    // 1段目: 高域シェルフ（頭部の音響効果のモデル）
    let f0 = 1681.974450955533;
    let Q = 0.7071752369554196;
    const db = 3.999843853973347;
    let K = Math.tan(Math.PI * f0 / sr);
    const Vh = Math.pow(10, db / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const hs = {
      b0: (Vh + Vb * K / Q + K * K) / a0,
      b1: 2 * (K * K - Vh) / a0,
      b2: (Vh - Vb * K / Q + K * K) / a0,
      a1: 2 * (K * K - 1) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    // 2段目: ハイパス（RLB 重み付け）。b は正規化しない（仕様の表も 1, -2, 1 のまま）
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / sr);
    a0 = 1 + K / Q + K * K;
    const hp = {
      b0: 1, b1: -2, b2: 1,
      a1: 2 * (K * K - 1) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    return { hs, hp };
  }

  constructor(sampleRate, numChannels, weights) {
    this.sr = sampleRate;
    this.nch = Math.max(1, numChannels | 0);
    this.w = weights && weights.length >= this.nch ? weights : new Array(this.nch).fill(1);
    this.k = DawLoudnessCore.kCoeffs(sampleRate);
    this.hopLen = Math.round(0.1 * sampleRate);   // 100ms ホップ（400ms ブロックの 75% 重なり）
    this.ST_HOPS = 30;                            // Short Term = 3s = 30 ホップ

    // True Peak 用 4倍ポリフェーズ FIR（窓付き sinc、48 タップ = 4 位相 x 12）。
    // 各位相のタップ和を 1 に正規化して DC ゲインを揃える。
    const L = 48, OS = 4, c = (L - 1) / 2;
    const taps = new Float64Array(L);
    for (let i = 0; i < L; i++) {
      const t = (i - c) / OS;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      taps[i] = s * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / L));
    }
    this.tpPhases = [];
    for (let p = 0; p < OS; p++) {
      const ph = new Float64Array(L / OS);
      let sum = 0;
      for (let m = 0; m < ph.length; m++) { ph[m] = taps[p + OS * m]; sum += ph[m]; }
      for (let m = 0; m < ph.length; m++) ph[m] /= sum;
      this.tpPhases.push(ph);
    }
    this.reset();
  }

  reset() {
    // K フィルタ状態（ch ごとに 2段 x {x1,x2,y1,y2}）
    this.fs = [];
    // True Peak の遅延線（ch ごとに直近 12 サンプル）
    this.tpHist = [];
    for (let c = 0; c < this.nch; c++) {
      this.fs.push(new Float64Array(8));
      this.tpHist.push(new Float64Array(this.tpPhases[0].length));
    }
    this.hopSum = 0;         // 現在のホップの重み付き自乗和
    this.hopFill = 0;
    this.hops = new Float64Array(this.ST_HOPS);   // 直近 30 ホップの自乗和（リング）
    this.hopCount = 0;
    this.blocks = [];        // 絶対ゲート(-70 LUFS)を通過した 400ms ブロックの平均パワー
    this.tpMax = 0;          // True Peak（線形）
  }

  // channels: Float32Array の配列。frames サンプルぶん取り込む。
  // ホップ境界がフレームの途中に落ちても正しく切れるよう、サンプル主導で回す
  // （チャンネル主導で回すと、境界時点で他チャンネルの未来のサンプルまで
  //   hopSum に混ざってしまう）。
  process(channels, frames) {
    const nch = Math.min(this.nch, channels.length);
    const k = this.k;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        const v = channels[c][i];
        const st = this.fs[c];
        const hist = this.tpHist[c];
        const hlen = hist.length;

        // ---- True Peak（フィルタ前の素の信号で測る）----
        for (let m = hlen - 1; m > 0; m--) hist[m] = hist[m - 1];
        hist[0] = v;
        const av = v < 0 ? -v : v;
        if (av > this.tpMax) this.tpMax = av;
        for (let p = 0; p < 4; p++) {
          const ph = this.tpPhases[p];
          let y = 0;
          for (let m = 0; m < hlen; m++) y += ph[m] * hist[m];
          const ay = y < 0 ? -y : y;
          if (ay > this.tpMax) this.tpMax = ay;
        }

        // ---- K特性（シェルフ -> ハイパス）----
        const y1 = k.hs.b0 * v + k.hs.b1 * st[0] + k.hs.b2 * st[1] - k.hs.a1 * st[2] - k.hs.a2 * st[3];
        st[1] = st[0]; st[0] = v;
        st[3] = st[2]; st[2] = y1;
        const y2 = k.hp.b0 * y1 + k.hp.b1 * st[4] + k.hp.b2 * st[5] - k.hp.a1 * st[6] - k.hp.a2 * st[7];
        st[5] = st[4]; st[4] = y1;
        st[7] = st[6]; st[6] = y2;

        this.hopSum += this.w[c] * y2 * y2;
      }
      this.hopFill++;
      if (this.hopFill >= this.hopLen) this._completeHop();
    }
  }

  _completeHop() {
    this.hops[this.hopCount % this.ST_HOPS] = this.hopSum;
    this.hopCount++;
    this.hopSum = 0;
    this.hopFill = 0;
    // 直近 4 ホップ = 1 ゲーティングブロック（400ms）。絶対ゲート -70 LUFS を
    // 通過したものだけ蓄積する（相対ゲートは integrated() で毎回かけ直す）。
    if (this.hopCount >= 4) {
      const p = this._lastPower(4);
      if (p > 0 && -0.691 + 10 * Math.log10(p) > -70) this.blocks.push(p);
    }
  }

  // 直近 n ホップの平均パワー（重み付き自乗平均）
  _lastPower(n) {
    if (this.hopCount < n) return 0;
    let s = 0;
    for (let j = this.hopCount - n; j < this.hopCount; j++) s += this.hops[j % this.ST_HOPS];
    return s / (n * this.hopLen);
  }

  static lufs(power) {
    return power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;
  }

  // Momentary: 直近 400ms（ホップ完了ごとに 10Hz で更新される）
  momentary() {
    return DawLoudnessCore.lufs(this._lastPower(4));
  }

  // Short Term: 直近 3s（開始直後はまだ窓が埋まっていないのであるぶんだけで計算）
  shortTerm() {
    return DawLoudnessCore.lufs(this._lastPower(Math.min(this.ST_HOPS, this.hopCount)));
  }

  // Integrated: 絶対ゲート通過ブロックの平均から相対しきい値（-10 LU）を求め、
  // それを超えるブロックだけの平均を返す（BS.1770-4 の2段ゲーティング）。
  integrated() {
    const blocks = this.blocks;
    if (!blocks.length) return -Infinity;
    let sum = 0;
    for (const p of blocks) sum += p;
    // 相対しきい値 (LUFS) = mean - 10。パワー比較に直して log を1回で済ます
    const lim = (sum / blocks.length) * 0.1;   // 10^(-10/10) = 0.1
    let s2 = 0, n2 = 0;
    for (const p of blocks) if (p > lim) { s2 += p; n2++; }
    return n2 ? DawLoudnessCore.lufs(s2 / n2) : -Infinity;
  }

  truePeakDb() {
    return this.tpMax > 0 ? 20 * Math.log10(this.tpMax) : -Infinity;
  }
}
`;
  },

  moduleSource() {
    return this.coreSource() + `
class DawLoudnessTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = options.processorOptions || {};
    this.core = new DawLoudnessCore(sampleRate, po.channels || 2, po.weights || null);
    this._sentHop = 0;
    this.port.onmessage = e => {
      if (e.data && e.data.type === 'reset') { this.core.reset(); this._sentHop = 0; this._post(); }
    };
  }
  _post() {
    this.port.postMessage({ type: 'state', state: {
      momentary: this.core.momentary(),
      shortTerm: this.core.shortTerm(),
      integrated: this.core.integrated(),
      truePeak: this.core.tpMax,
      truePeakDb: this.core.truePeakDb(),
    } });
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0].length) {
      this.core.process(input, input[0].length);
      // ホップ（100ms）が進んだときだけ送る = メインスレッドへは 10Hz
      if (this.core.hopCount !== this._sentHop) {
        this._sentHop = this.core.hopCount;
        this._post();
      }
    }
    return true;   // 出力は常に無音（メーター専用タップ。音の経路には影響しない）
  }
}
registerProcessor('daw-loudness', DawLoudnessTap);
`;
  },

  // メインスレッド側で同じ DSP クラスを得る（Worklet と同一のソースから作る）
  Core() {
    if (!this._Core) this._Core = new Function(this.coreSource() + '\nreturn DawLoudnessCore;')();
    return this._Core;
  },

  // K特性係数（テスト・検証用の入口）
  kCoeffs(sr) {
    return this.Core().kCoeffs(sr);
  },

  // ---- 純関数 API（書き出しレポート・テストが使う）----

  // buffers: AudioBuffer 互換（getChannelData を持つ）または Float32Array の配列
  _chans(buffers, sampleRate) {
    if (Array.isArray(buffers)) return { chans: buffers, sr: sampleRate };
    const chans = [];
    for (let c = 0; c < buffers.numberOfChannels; c++) chans.push(buffers.getChannelData(c));
    return { chans, sr: sampleRate || buffers.sampleRate };
  },

  // 一括計測。Integrated / True Peak をまとめて返す（1パス）。
  analyze(buffers, sampleRate) {
    const { chans, sr } = this._chans(buffers, sampleRate);
    const core = new (this.Core())(sr, chans.length, this.weightsFor(chans.length));
    core.process(chans, chans.length ? chans[0].length : 0);
    return {
      integrated: core.integrated(),
      truePeak: core.tpMax,
      truePeakDb: core.truePeakDb(),
    };
  },

  integrated(buffers, sampleRate) {
    return this.analyze(buffers, sampleRate).integrated;
  },

  truePeak(buffers, sampleRate) {
    return this.analyze(buffers, sampleRate).truePeak;
  },

  // Momentary / Short Term の逐次計算器。process(channels, frames) で流し込み、
  // momentary() / shortTerm() / integrated() / truePeakDb() を随時読む。
  createMeter(sampleRate, numChannels) {
    const nch = numChannels || 2;
    return new (this.Core())(sampleRate, nch, this.weightsFor(nch));
  },

  // LUFS / dBTP の表示用。-∞ は記号で出す（js/objui.js の fmtDb と同じ流儀）
  fmt(v) {
    return isFinite(v) ? v.toFixed(1) : '-∞';
  },

  // ---- ライブ計測（AudioWorklet）----

  // tap（masterGain = リミッター前）へタップノードをぶら下げる。
  // blob: URL は file:// で AbortError になるため data: URL（js/limiter.js と同じ）。
  // 出力はデスティネーションへ繋ぐが常に無音（繋がないとグラフから外れて process が呼ばれない）。
  async attach(ctx, tap) {
    if (this.node) return this.node;
    if (this._failed) return null;
    if (this._pending) return this._pending;
    this._pending = (async () => {
      try {
        if (!this.modUrl) {
          this.modUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(this.moduleSource());
        }
        await ctx.audioWorklet.addModule(this.modUrl);
        if (this.node) return this.node;   // 競合して二重に作らない
        const node = new AudioWorkletNode(ctx, 'daw-loudness', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 2,
          channelCountMode: 'explicit',
          processorOptions: { channels: 2, weights: this.weightsFor(2) },
        });
        node.port.onmessage = e => {
          const d = e.data;
          if (d && d.type === 'state') Object.assign(this.live, d.state);
        };
        tap.connect(node);
        node.connect(ctx.destination);
        this.node = node;
        return node;
      } catch (e) {
        // Worklet が読めない環境では計測なしで動き続ける（再生は止めない）
        this._failed = true;
        console.warn('ラウドネス計測を初期化できないため METERING は -∞ のままになります:', e);
        return null;
      } finally {
        this._pending = null;
      }
    })();
    return this._pending;
  },

  // Integrated / True Peak の蓄積をやり直す（METERING タブのリセットボタン）。
  // Momentary / Short Term は流れてくる音からすぐ再構築される。
  reset() {
    this.live = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeak: 0, truePeakDb: -Infinity };
    if (this.node) this.node.port.postMessage({ type: 'reset' });
  },
};
