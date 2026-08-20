'use strict';

// マルチバンドコンプレッサー（3バンド、FL Studio の Maximus 風）
//
// 帯域分割は Linkwitz-Riley 4次（24dB/oct）相当:
//   BiquadFilter の lowpass / highpass（Butterworth Q）を2段カスケードすると LR4 になる。
//   LR4 の LP+HP の和は2次オールパス（振幅フラット・位相のみ回る）なので、
//   3バンドを下のツリー構成にすると全帯域の再合算がフラットに戻る。
//
//     低  = LP4(f1) → AP2(f2)          ← AP2 は位相整合用の2次オールパス
//     中  = HP4(f1) → LP4(f2)
//     高  = HP4(f1) → HP4(f2)
//     和  = AP2(f1)·AP2(f2)            ← 振幅 1（フラット）
//
//   ※ Web Audio の罠: lowpass/highpass の Q は「dB」解釈、allpass の Q は線形。
//     Butterworth にするには LP/HP へ -3.0103dB、AP へ 0.7071 を与える。
//
// 各バンドは 分割フィルタ → DynamicsCompressorNode → バンドゲイン、
// 合算後にマスターゲイン。ネイティブノードだけで構成しているので
// AudioContext / OfflineAudioContext のどちらでも同一挙動（書き出し一致）になる。
// バンドの内訳ノード一式は goodizer.js（1ノブ版）からも流用される。
(() => {
  const Q_BW_DB = 20 * Math.log10(Math.SQRT1_2); // ≈ -3.0103dB（LP/HP 用 Butterworth Q）
  const dB = v => Math.pow(10, v / 20);

  const BANDS = [
    { p: 'l', jp: '低' },
    { p: 'm', jp: '中' },
    { p: 'h', jp: '高' },
  ];

  function bandParams(p, jp) {
    return [
      { key: p + 'thr', label: jp + 'Thr', min: -60, max: 0, step: 1, default: -24 },
      { key: p + 'ratio', label: jp + 'Ratio', min: 1, max: 20, step: 0.5, default: 2 },
      { key: p + 'att', label: jp + 'Att', min: 0.001, max: 0.2, step: 0.001, default: 0.01 },
      { key: p + 'rel', label: jp + 'Rel', min: 0.02, max: 1, step: 0.01, default: 0.2 },
      { key: p + 'gain', label: jp + 'Gain', min: -24, max: 12, step: 0.5, default: 0 },
    ];
  }

  DAW.plugins.register({
    id: 'multiband',
    name: 'マルチバンドコンプ',
    params: [
      { key: 'xlow', label: '交差低', min: 40, max: 1000, step: 1, default: 200 },
      { key: 'xhigh', label: '交差高', min: 800, max: 12000, step: 10, default: 2500 },
    ].concat(...BANDS.map(b => bandParams(b.p, b.jp)),
      [{ key: 'master', label: 'マスター', min: -24, max: 12, step: 0.5, default: 0 }]),

    create(ctx, params) {
      const cur = Object.assign({}, params); // クロスオーバーのクランプ用に現在値を持つ
      const f1 = () => cur.xlow;
      const f2 = () => Math.max(cur.xhigh, cur.xlow); // 高側が低側を下回らないように

      const filt = (type, freq) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = type === 'allpass' ? Math.SQRT1_2 : Q_BW_DB;
        return f;
      };

      const input = ctx.createGain();
      const master = ctx.createGain();
      master.gain.value = dB(cur.master);

      // 1バンド分: 分割フィルタ列 → コンプ → バンドゲイン → マスター
      const bands = {};
      const makeBand = (prefix, filters) => {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = cur[prefix + 'thr'];
        comp.ratio.value = cur[prefix + 'ratio'];
        comp.attack.value = cur[prefix + 'att'];
        comp.release.value = cur[prefix + 'rel'];
        comp.knee.value = 6;
        const gain = ctx.createGain();
        gain.gain.value = dB(cur[prefix + 'gain']);
        let prev = input;
        for (const f of filters) { prev.connect(f); prev = f; }
        prev.connect(comp);
        comp.connect(gain);
        gain.connect(master);
        bands[prefix] = { comp, gain, filters };
      };
      makeBand('l', [filt('lowpass', f1()), filt('lowpass', f1()), filt('allpass', f2())]);
      makeBand('m', [filt('highpass', f1()), filt('highpass', f1()), filt('lowpass', f2()), filt('lowpass', f2())]);
      makeBand('h', [filt('highpass', f1()), filt('highpass', f1()), filt('highpass', f2()), filt('highpass', f2())]);

      const ramp = (param, v) => param.setTargetAtTime(v, ctx.currentTime, 0.01);
      // 分割フィルタの周波数を現在のクロスオーバーへ合わせ直す
      const retune = () => {
        const a = f1(), b = f2();
        ramp(bands.l.filters[0].frequency, a);
        ramp(bands.l.filters[1].frequency, a);
        ramp(bands.l.filters[2].frequency, b); // 低バンドの位相合わせ AP は f2
        for (const p of ['m', 'h']) {
          ramp(bands[p].filters[0].frequency, a);
          ramp(bands[p].filters[1].frequency, a);
          ramp(bands[p].filters[2].frequency, b);
          ramp(bands[p].filters[3].frequency, b);
        }
      };

      return {
        input,
        output: master,
        set(key, v) {
          cur[key] = v;
          if (key === 'xlow' || key === 'xhigh') { retune(); return; }
          if (key === 'master') { ramp(master.gain, dB(v)); return; }
          const b = bands[key[0]];
          if (!b) return;
          const sub = key.slice(1);
          if (sub === 'thr') ramp(b.comp.threshold, v);
          else if (sub === 'ratio') ramp(b.comp.ratio, v);
          else if (sub === 'att') ramp(b.comp.attack, v);
          else if (sub === 'rel') ramp(b.comp.release, v);
          else if (sub === 'gain') ramp(b.gain.gain, dB(v));
        },
      };
    },
  });
})();
