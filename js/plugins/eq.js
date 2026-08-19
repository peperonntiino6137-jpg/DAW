'use strict';

// 7バンド グラフィックイコライザー（各バンド ±12dB）
// 低域: lowshelf / 中域: peaking / 高域: highshelf の直列チェーン
DAW.plugins.register({
  id: 'geq7',
  name: 'グラフィックEQ',
  params: [
    { key: 'b60', label: '60Hz', min: -12, max: 12, step: 0.5, default: 0 },
    { key: 'b150', label: '150Hz', min: -12, max: 12, step: 0.5, default: 0 },
    { key: 'b400', label: '400Hz', min: -12, max: 12, step: 0.5, default: 0 },
    { key: 'b1k', label: '1kHz', min: -12, max: 12, step: 0.5, default: 0 },
    { key: 'b2k4', label: '2.4kHz', min: -12, max: 12, step: 0.5, default: 0 },
    { key: 'b6k', label: '6kHz', min: -12, max: 12, step: 0.5, default: 0 },
    { key: 'b15k', label: '15kHz', min: -12, max: 12, step: 0.5, default: 0 },
  ],
  create(ctx, params) {
    const BANDS = [
      { key: 'b60', freq: 60, type: 'lowshelf' },
      { key: 'b150', freq: 150, type: 'peaking' },
      { key: 'b400', freq: 400, type: 'peaking' },
      { key: 'b1k', freq: 1000, type: 'peaking' },
      { key: 'b2k4', freq: 2400, type: 'peaking' },
      { key: 'b6k', freq: 6000, type: 'peaking' },
      { key: 'b15k', freq: 15000, type: 'highshelf' },
    ];
    const filters = new Map();
    let first = null;
    let prev = null;
    for (const b of BANDS) {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      if (b.type === 'peaking') f.Q.value = 1.1;
      f.gain.value = params[b.key];
      filters.set(b.key, f);
      if (prev) prev.connect(f); else first = f;
      prev = f;
    }
    return {
      input: first,
      output: prev,
      set(key, v) {
        const f = filters.get(key);
        if (f) f.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
      },
    };
  },
});
