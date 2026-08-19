'use strict';

DAW.plugins.register({
  id: 'lowpass',
  name: 'ローパス',
  params: [
    { key: 'freq', label: '周波数', min: 100, max: 18000, step: 1, default: 8000 },
    { key: 'q', label: 'レゾナンス', min: 0.1, max: 15, step: 0.1, default: 0.8 },
  ],
  create(ctx, params) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = params.freq;
    f.Q.value = params.q;
    return {
      input: f,
      output: f,
      set(key, v) {
        if (key === 'freq') f.frequency.setTargetAtTime(v, ctx.currentTime, 0.01);
        else if (key === 'q') f.Q.setTargetAtTime(v, ctx.currentTime, 0.01);
      },
    };
  },
});
