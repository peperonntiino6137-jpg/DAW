'use strict';

// 7バンド パラメトリックEQ（FL Studio「Parametric EQ 2」の DSP 部分に相当）
//
// 7つの BiquadFilterNode を常時直列につなぎ、再配線は一切しない。
// 各バンド: 有効 on/off / 型（bell / low-shelf / high-shelf / lowpass /
// highpass / notch / bandpass）/ 周波数 / ゲイン / Q。
//
// バイパスの実現: バンド無効時は「peaking（bell）+ ゲイン 0dB」に切り替える。
// peaking のゲイン 0dB は伝達関数が厳密に 1（素通し）なので、ノードを外さずに
// 無音化クリックなしでバイパスできる。型の切替自体は仕様どおり瞬時。
// 周波数・ゲイン・Q のライブ変更は setTargetAtTime で短くなめして
// ズリズリ動かしてもクリックが出ないようにする。
//
// 既定値は「挿した瞬間に音が変わらない」状態:
//   B1 = highpass 30Hz（無効）/ B7 = lowpass 18kHz（無効）/
//   B2〜B6 = bell 0dB（有効だが利得 0 なので素通し）
//
// 戻り値に getFrequencyResponse(freqArray) → magArray を持つ
// （各 BiquadFilter.getFrequencyResponse の振幅の積）。
// フェーズ3のスペクトラム表示 UI がこれを使う想定。UI 本体は未実装。
(() => {
  // 型スライダーの値（0〜6）→ BiquadFilter.type の対応表
  const TYPES = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass'];
  // ゲインつまみが効く型（それ以外の型では Web Audio 仕様上ゲインは無視される）
  const GAIN_TYPES = { peaking: 1, lowshelf: 1, highshelf: 1 };

  // バンドごとの既定値。周波数は 20〜20kHz を対数でほぼ等間隔に割り振る
  // （UI スライダーは線形だが、値の並びとしては log 配置）。
  const DEFAULTS = [
    { ty: 4, fq: 30, on: 0, q: 0.7 },    // B1: ローカット（既定は無効）
    { ty: 0, fq: 100, on: 1, q: 1 },
    { ty: 0, fq: 315, on: 1, q: 1 },
    { ty: 0, fq: 1000, on: 1, q: 1 },
    { ty: 0, fq: 3150, on: 1, q: 1 },
    { ty: 0, fq: 8000, on: 1, q: 1 },
    { ty: 3, fq: 18000, on: 0, q: 0.7 }, // B7: ハイカット（既定は無効）
  ];

  // 35 個のパラメータ記述子（7 バンド × 5）。ラベルは「B1型」等で簡潔に
  const params = [];
  for (let i = 0; i < 7; i++) {
    const n = i + 1;
    const d = DEFAULTS[i];
    params.push(
      { key: 'on' + n, label: 'B' + n + '有効', min: 0, max: 1, step: 1, default: d.on },
      { key: 'ty' + n, label: 'B' + n + '型', min: 0, max: 6, step: 1, default: d.ty },
      { key: 'fq' + n, label: 'B' + n + '周波', min: 20, max: 20000, step: 1, default: d.fq },
      { key: 'gn' + n, label: 'B' + n + 'ゲイン', min: -18, max: 18, step: 0.5, default: 0 },
      { key: 'q' + n, label: 'B' + n + 'Q', min: 0.1, max: 10, step: 0.1, default: d.q },
    );
  }

  DAW.plugins.register({
    id: 'paraeq',
    name: 'パラメトリックEQ',
    params,

    create(ctx, p) {
      // バンド状態（UI 値のミラー）と BiquadFilter を 7 本用意して直列接続
      const bands = [];
      let first = null;
      let prev = null;
      for (let i = 0; i < 7; i++) {
        const n = i + 1;
        const node = ctx.createBiquadFilter();
        bands.push({
          node,
          on: +p['on' + n],
          ty: +p['ty' + n],
          fq: +p['fq' + n],
          gn: +p['gn' + n],
          q: +p['q' + n],
        });
        if (prev) prev.connect(node); else first = node;
        prev = node;
      }

      // バンド状態をノードへ反映する。
      // immediate=true（生成直後）は .value 直接代入、ライブ変更は setTargetAtTime。
      // 無効バンドは peaking + ゲイン 0dB（= 厳密な素通し）へ落とす。
      const apply = (b, immediate) => {
        const on = b.on >= 0.5;
        const type = on ? TYPES[Math.max(0, Math.min(6, Math.round(b.ty)))] : 'peaking';
        const gain = on && GAIN_TYPES[type] ? b.gn : 0;
        const freq = Math.max(20, Math.min(20000, b.fq));
        const q = Math.max(0.1, Math.min(10, b.q));
        if (b.node.type !== type) b.node.type = type; // 型切替は瞬時でよい（仕様）
        if (immediate) {
          b.node.frequency.value = freq;
          b.node.Q.value = q;
          b.node.gain.value = gain;
        } else {
          const t = ctx.currentTime;
          b.node.frequency.setTargetAtTime(freq, t, 0.01);
          b.node.Q.setTargetAtTime(q, t, 0.01);
          b.node.gain.setTargetAtTime(gain, t, 0.01);
        }
      };
      for (const b of bands) apply(b, true);

      return {
        input: first,
        output: prev,

        set(key, value) {
          const m = /^(on|ty|fq|gn|q)([1-7])$/.exec(key);
          if (!m) return;
          const b = bands[+m[2] - 1];
          b[m[1]] = +value;
          // 型は apply 内で瞬時に切り替わり、連続値（周波数・ゲイン・Q）は
          // 常になめして反映される。bell バンドの on/off は型が変わらないため
          // ゲインのフェードだけになり、クリックが出ない。
          apply(b, false);
        },

        // 現在の全バンドを合成した振幅特性を返す（各フィルタの振幅の積）。
        // 無効バンドは peaking 0dB = 振幅 1 なので積に影響しない。
        getFrequencyResponse(freqArray) {
          const fr = freqArray instanceof Float32Array ? freqArray : Float32Array.from(freqArray);
          const mag = new Float32Array(fr.length);
          const phase = new Float32Array(fr.length);
          const out = new Float32Array(fr.length).fill(1);
          for (const b of bands) {
            b.node.getFrequencyResponse(fr, mag, phase);
            for (let i = 0; i < out.length; i++) out[i] *= mag[i];
          }
          return out;
        },
      };
    },
  });
})();
