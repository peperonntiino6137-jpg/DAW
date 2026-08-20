'use strict';

// グッダイザー（Soundgoodizer 風の1ノブ・エンハンサー）
//
// DSP は multiband.js（3バンドコンプ）をそのまま流用し、ノブ1つ（amount 0..1）から
// 3バンド分の threshold / ratio / gain を導出して渡すだけの「パッケージング」プラグイン。
// カーブの狙い:
//   - amount を上げるほど各バンドのしきい値を下げ、レシオを上げる（音圧アップ）
//   - 下げた分は自動メイクアップ（-thr·(1-1/ratio)·0.4）で持ち上げる
//   - 低域・高域にわずかなチルトを足してスマイルカーブにする
//   - アタック/リリースは帯域ごとの定数（低域ほど遅く）
// amount 0 のときは thr 0dB / ratio 1 / gain 0dB になり、帯域分割（振幅フラット）を
// 通るだけのほぼ素通しになる。
(() => {
  // amount から multiband の全パラメータを導出する
  function curve(a) {
    const p = { xlow: 200, xhigh: 3000, master: 0 };
    const bands = {
      l: { depth: 30, ratio: 3.0, att: 0.02, rel: 0.25, tilt: 1.5 },
      m: { depth: 22, ratio: 2.0, att: 0.01, rel: 0.15, tilt: 0 },
      h: { depth: 26, ratio: 2.5, att: 0.005, rel: 0.1, tilt: 1.0 },
    };
    for (const k in bands) {
      const b = bands[k];
      const thr = -b.depth * a;
      const ratio = 1 + b.ratio * a;
      p[k + 'thr'] = thr;
      p[k + 'ratio'] = ratio;
      p[k + 'att'] = b.att;
      p[k + 'rel'] = b.rel;
      p[k + 'gain'] = -thr * (1 - 1 / ratio) * 0.4 + b.tilt * a; // 自動メイクアップ + チルト
    }
    return p;
  }

  DAW.plugins.register({
    id: 'goodizer',
    name: 'グッダイザー',
    params: [
      { key: 'amount', label: '量', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    create(ctx, params) {
      const inner = DAW.plugins.get('multiband').create(ctx, curve(params.amount));
      return {
        input: inner.input,
        output: inner.output,
        set(key, v) {
          if (key !== 'amount') return;
          const p = curve(v);
          for (const k in p) inner.set(k, p[k]);
        },
      };
    },
  });
})();
