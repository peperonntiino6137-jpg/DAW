'use strict';

// コンプレッサー。
// DynamicsCompressorNode をそのまま使い、後段にメイクアップゲインを足しただけの素直な作り。
// 圧縮で下がった音量を持ち上げるためのゲインが無いと使いづらいので、それだけ追加している。
DAW.plugins.register({
  id: 'comp',
  name: 'コンプレッサー',
  params: [
    { key: 'threshold', label: 'しきい値', min: -60, max: 0, step: 1, default: -24 },
    { key: 'ratio', label: 'レシオ', min: 1, max: 20, step: 0.5, default: 4 },
    { key: 'attack', label: 'アタック', min: 0.001, max: 0.2, step: 0.001, default: 0.01 },
    { key: 'release', label: 'リリース', min: 0.02, max: 1, step: 0.01, default: 0.25 },
    { key: 'makeup', label: '出力ゲイン', min: 0.5, max: 4, step: 0.05, default: 1 },
  ],
  create(ctx, params) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = params.threshold;
    comp.ratio.value = params.ratio;
    comp.attack.value = params.attack;
    comp.release.value = params.release;
    comp.knee.value = 6;
    const makeup = ctx.createGain();
    makeup.gain.value = params.makeup;
    comp.connect(makeup);
    return {
      input: comp,
      output: makeup,
      set(key, v) {
        if (key === 'makeup') makeup.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
        else if (comp[key]) comp[key].setTargetAtTime(v, ctx.currentTime, 0.01);
      },
    };
  },
});
