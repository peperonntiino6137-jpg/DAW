'use strict';

// タイムFX（Gross Beat 風のテンポ同期グリッチ / スタッター）
//
// AudioWorklet 内に直近2小節ぶんのリングバッファを常時録音し、
//   readPos = playPos - f(phase)   （f はタイムカーブ、phase は小節内位相 0..1）
// で読み出す。f の単位は拍（4/4 固定・1小節 = 4拍）。ボリュームカーブは独立で、
// 出力ゲイン g(phase) を掛ける。「深さ」(mix) はカーブの効き量
// （遅延は mix 倍・ゲインは 1 と g の補間）で、原音との dry/wet はホスト側
// （wrapper のスロット MIX）が持つのでここでは持たない。
//
// 位相の基準（ライブと書き出しで同じ音になるための肝）:
//   タイムライン位置 tl = pos0 + (ctx時刻 - ctxTime0) の線形対応だけを Worklet に教える。
//   - ライブ: DAW.audio.play() が確定させる playStartPos / playStartCtxTime がそのまま
//     (pos0, ctxTime0)。play() を後付けフック（このファイル内）でラップし、再生開始の
//     たびに全ライブインスタンスへ transport メッセージで送り直す（seek / reschedule も
//     play() を通るので拾える）。再生途中でチェーンが組み直された場合は create() が
//     その時点の値を processorOptions で渡す。
//   - 書き出し: OfflineAudioContext は currentTime=0 起点なので、exportMix() が
//     設定する DAW.objaudio.exportRange.from を pos0 に渡すだけでよい
//     （ctxTime0=0）。これで再生開始/書き出し範囲が小節の途中でも位相が合う。
//   BPM は processorOptions で渡し、transport メッセージ / set('bpm', v) で更新する。
//
// クリック回避:
//   - タイムカーブの不連続（セグメント境界・小節の折り返し・パターン切替・transport
//     再同期）は読み出しヘッドを2本使い、旧ヘッドを直前の傾きのまま走らせて
//     約5ms の等ゲインクロスフェードで新ヘッドへ乗り換える。
//   - ボリュームカーブのエッジと深さ変更はスルーレート制限（約3ms / 10ms）で滑らかにする。
//
// 既知の割り切り: ループ再生の折り返しは線形対応のままなので、ループ長が
// 小節の整数倍でないと折り返し後の位相はタイムライン基準のままになる。
(() => {
  const PROCESSOR = `
class TimeFXProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options.processorOptions || {};
    this.fs = sampleRate;
    this.pos0 = +p.pos0 || 0;      // ctxTime0 のときのタイムライン位置（秒）
    this.t0 = +p.ctxTime0 || 0;    // 対応する ctx 時刻（秒）
    this.timePat = Math.round(p.timePattern) || 0;
    this.volPat = Math.round(p.volPattern) || 0;
    const m = +p.mix; this.mix = isFinite(m) ? Math.max(0, Math.min(1, m)) : 1;
    this.mixCur = this.mix;
    this.gainCur = -1;             // 負 = 未初期化（最初のサンプルでターゲットへ直接合わせる）
    this.fadeLen = Math.max(32, Math.round(0.005 * this.fs));   // 乗り換えクロスフェード約5ms
    this.fade = 0;                 // 残りフェードサンプル数（>0 の間は旧ヘッドと混ぜる）
    this.dA = 0; this.slopeA = 0;  // 現行ヘッドの遅延（サンプル）と直前の傾き
    this.dB = 0; this.slopeB = 0;  // 旧ヘッド（フェードアウト側）
    this.havePrev = false;
    this.chans = [];               // リングバッファ（チャンネルごと）
    this.cap = 0;
    this.w = -1;                   // 直近に書き込んだリング位置
    this.setBpm(+p.bpm || 120);
    this.port.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'transport') {
        // 再生開始のたびに届く。位相対応の付け替えで遅延が跳んでも
        // process 側の不連続検出がクロスフェードしてくれる。
        this.pos0 = +d.pos0 || 0;
        this.t0 = +d.ctxTime0 || 0;
        if (d.bpm) this.setBpm(d.bpm);
      }
      else if (d.key === 'timePattern') this.timePat = Math.round(d.value) || 0;
      else if (d.key === 'volPattern') this.volPat = Math.round(d.value) || 0;
      else if (d.key === 'mix') { const v = +d.value; this.mix = isFinite(v) ? Math.max(0, Math.min(1, v)) : this.mix; }
      else if (d.key === 'bpm') this.setBpm(d.value);
    };
  }

  setBpm(v) {
    this.bpm = Math.max(20, Math.min(300, +v || 120));
    this.bt = this.fs * 60 / this.bpm;   // 1拍のサンプル数
    this.barSec = 240 / this.bpm;        // 1小節（4拍）の秒数
    // 2小節ぶん + フェード + 余裕。拡張のみ（BPM を下げたときだけ作り直し）。
    // 作り直しは過去の録音を捨てるが、BPM 変更は稀なので一瞬の無音を許容する。
    const need = Math.ceil(2 * this.barSec * this.fs) + this.fadeLen + 256;
    if (need > this.cap) {
      this.cap = need;
      for (let i = 0; i < this.chans.length; i++) this.chans[i] = new Float32Array(need);
      this.w = -1;
    }
  }

  ensureCh(n) {
    while (this.chans.length < n) this.chans.push(new Float32Array(this.cap));
  }

  // タイムカーブ f(tb) : 小節内の拍位置 tb (0..4) → 遅延（拍）。常に 0 以上（未来は読めない）。
  delayBeats(tb) {
    switch (this.timePat) {
      case 1: return tb * 0.5;                          // ハーフスピード（1小節かけて半分の速さ）
      case 2: return Math.floor(tb);                    // 1拍リピート（1拍目を4回）
      case 3: { const f = tb - Math.floor(tb); return f >= 0.5 ? 0.5 : 0; }          // 1/2拍リピート
      case 4: { const f = tb - Math.floor(tb); return Math.floor(f * 4) * 0.25; }    // 1/4拍スタッター
      case 5: return (tb - Math.floor(tb)) * 2;         // 逆再生風（各拍で直前1拍を逆走）
      case 6: return tb * tb / 8;                       // テープストップ（小節末で速度0へ）
      case 7: {                                         // シャッフル（半拍スロットの並べ替え）
        const j = Math.min(7, Math.floor(tb * 2));
        return (j - TimeFXProcessor.SHUF[j]) * 0.5;
      }
      default: return 0;                                // 素通し
    }
  }

  // ボリュームカーブ g(tb) : 0..1
  volAt(tb) {
    switch (this.volPat) {
      case 1: return (tb - Math.floor(tb)) < 0.5 ? 1 : 0;                    // 4分ゲート
      case 2: { const h = tb * 2; return (h - Math.floor(h)) < 0.5 ? 1 : 0; }// 8分ゲート
      case 3: { const f = tb - Math.floor(tb); const u = f / 0.6;            // サイドチェイン風デューク
                return u >= 1 ? 1 : u * u; }
      default: return 1;
    }
  }

  // 書き込み位置 w から d サンプル過去を線形補間で読む
  read(ch, d) {
    const pos = this.w - d;
    let p0 = Math.floor(pos);
    const frac = pos - p0;
    const cap = this.cap;
    let i0 = p0 % cap; if (i0 < 0) i0 += cap;
    let i1 = i0 + 1; if (i1 >= cap) i1 = 0;
    const b = this.chans[ch];
    return b[i0] * (1 - frac) + b[i1] * frac;
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || inp.length === 0) return true;
    const n = inp[0].length;
    const nch = inp.length;
    this.ensureCh(nch);
    const mStep = 1 / (0.01 * this.fs);   // 深さのスルー（約10ms）
    const gStep = 1 / (0.003 * this.fs);  // ゲートエッジのスルー（約3ms）
    // 不連続の判定しきい値。カーブの連続変化（最大でも逆再生の 2 サンプル/サンプル +
    // 深さスルーによる掃引）よりは大きく、最小セグメント（1/4拍）の跳びよりは小さい値。
    const JUMP = Math.max(64, 0.05 * this.bt);
    const maxD = this.cap - 8;
    for (let i = 0; i < n; i++) {
      // 常時録音（エフェクトが素通しでも書き続ける）
      this.w++; if (this.w >= this.cap) this.w = 0;
      for (let ch = 0; ch < nch; ch++) this.chans[ch][this.w] = inp[ch][i];

      // タイムライン位置 → 小節内の拍位置 tb (0..4)
      const tl = this.pos0 + (currentTime + i / this.fs - this.t0);
      let q = tl / this.barSec;
      q -= Math.floor(q);   // 負の位置でも 0..1 に折り返す
      const tb = q * 4;

      // 深さのスルーレート制限
      const dm = this.mix - this.mixCur;
      this.mixCur += dm > mStep ? mStep : (dm < -mStep ? -mStep : dm);

      // 遅延ターゲットと不連続検出
      let dT = this.mixCur * this.delayBeats(tb) * this.bt;
      if (dT < 0) dT = 0; else if (dT > maxD) dT = maxD;
      if (!this.havePrev) {
        this.havePrev = true;
        this.dA = dT;
      } else {
        const step = dT - this.dA;
        if (Math.abs(step) > JUMP) {
          // 跳んだ: 現行ヘッドを直前の傾きのまま旧ヘッドへ移し、新ヘッドへクロスフェード
          this.dB = this.dA + this.slopeA;
          this.slopeB = this.slopeA;
          this.fade = this.fadeLen;
          this.dA = dT;
          this.slopeA = 0;
        } else {
          this.slopeA = step;
          this.dA = dT;
        }
      }

      // ボリュームカーブ（スルーレート制限でエッジを丸める）
      const gT = 1 - this.mixCur * (1 - this.volAt(tb));
      if (this.gainCur < 0) this.gainCur = gT;
      else {
        const dg = gT - this.gainCur;
        this.gainCur += dg > gStep ? gStep : (dg < -gStep ? -gStep : dg);
      }

      // 読み出し（フェード中は旧ヘッドと等ゲインで混ぜる）
      let k = 0;
      if (this.fade > 0) {
        k = this.fade / this.fadeLen;
        this.dB += this.slopeB;
        if (this.dB < 0) this.dB = 0; else if (this.dB > maxD) this.dB = maxD;
        this.fade--;
      }
      for (let ch = 0; ch < nch; ch++) {
        let v = this.read(ch, this.dA);
        if (k > 0) v = v * (1 - k) + this.read(ch, this.dB) * k;
        if (out[ch]) out[ch][i] = v * this.gainCur;
      }
    }
    for (let ch = nch; ch < out.length; ch++) out[ch].fill(0);
    return true;
  }
}
TimeFXProcessor.SHUF = [0, 0, 2, 2, 3, 5, 4, 6];   // 半拍スロット j が再生する元スロット（j 以下限定）
registerProcessor('timefx', TimeFXProcessor);
`;

  const loading = new WeakMap(); // ctx -> Promise
  const ready = new WeakSet();   // モジュールロード済みの ctx
  let modUrl = null;             // blob: は file:// の Worklet で読めないので data: URL（js/limiter.js と同じ）

  const TIME_NAMES = ['素通し', 'ハーフスピード', '1拍リピート', '1/2拍リピート',
                      '1/4拍スタッター', '逆再生風', 'テープストップ', 'シャッフル'];
  const VOL_NAMES = ['素通し', '4分ゲート', '8分ゲート', 'デューク'];

  // ライブのトランスポート同期フック。play()（seek / reschedule も内部で通る）の完了後、
  // 確定した playStartPos / playStartCtxTime を全ライブインスタンスへ送り直す。
  // インスタンス一覧は trackNodes のスロット（wrapper 経由なら slot.inst）を辿るので
  // 登録簿は持たない = 破棄済みノードへの参照も残らない。
  if (DAW.audio && !DAW.audio._timefxTransportHook) {
    DAW.audio._timefxTransportHook = true;
    const origPlay = DAW.audio.play;
    DAW.audio.play = async function () {
      const r = await origPlay.apply(this, arguments);
      if (this.playing) {
        const msg = {
          type: 'transport',
          pos0: this.playStartPos,
          ctxTime0: this.playStartCtxTime,
          bpm: DAW.project.bpm,
        };
        for (const n of this.trackNodes.values()) {
          for (const slot of (n.fx || [])) {
            const inst = slot && (slot.inst || slot);
            if (inst && inst._timefxNode) inst._timefxNode.port.postMessage(msg);
          }
        }
      }
      return r;
    };
  }

  DAW.plugins.register({
    id: 'timefx',
    name: 'タイムFX',
    params: [
      { key: 'timePattern', label: 'タイム', min: 0, max: 7, step: 1, default: 0,
        format: v => TIME_NAMES[Math.round(v)] || String(v) },
      { key: 'volPattern', label: 'ゲート', min: 0, max: 3, step: 1, default: 0,
        format: v => VOL_NAMES[Math.round(v)] || String(v) },
      { key: 'mix', label: '深さ', min: 0, max: 1, step: 0.01, default: 1 },
    ],

    prepare(ctx) {
      if (ready.has(ctx)) return Promise.resolve();
      let p = loading.get(ctx);
      if (!p) {
        if (!modUrl) modUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(PROCESSOR);
        p = ctx.audioWorklet.addModule(modUrl).then(() => { ready.add(ctx); });
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
      // 位相の基準（冒頭コメント参照）。ライブで停止中に作られた場合は 0 のままでよく、
      // 次の play() のフックが正しい対応を届ける。
      let pos0 = 0, ctxTime0 = 0;
      const live = DAW.audio && ctx === DAW.audio.ctx;
      if (live) {
        if (DAW.audio.playing) {           // 再生中のチェーン組み直し
          pos0 = DAW.audio.playStartPos;
          ctxTime0 = DAW.audio.playStartCtxTime;
        }
      } else {
        const er = DAW.objaudio && DAW.objaudio.exportRange;
        if (er) pos0 = er.from;            // 書き出しは ctx.currentTime=0 = タイムラインの from
      }
      const node = new AudioWorkletNode(ctx, 'timefx', {
        processorOptions: {
          bpm: (DAW.project && DAW.project.bpm) || 120,
          pos0, ctxTime0,
          timePattern: params.timePattern,
          volPattern: params.volPattern,
          mix: params.mix,
        },
      });
      return {
        input: node,
        output: node,
        _timefxNode: node,   // トランスポートフックが探す目印
        set(key, value) { node.port.postMessage({ key, value }); },
      };
    },
  });
})();
