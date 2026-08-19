'use strict';

DAW.plugins.register({
  id: 'delay',
  name: 'ディレイ',
  params: [
    { key: 'time', label: '時間', min: 0.01, max: 1, step: 0.01, default: 0.3 },
    { key: 'feedback', label: '帰還', min: 0, max: 0.9, step: 0.01, default: 0.35 },
    { key: 'mix', label: 'ミックス', min: 0, max: 1, step: 0.01, default: 0.35 },
  ],
  create(ctx, params) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    const wet = ctx.createGain();
    input.connect(output);            // dry
    input.connect(delay);
    delay.connect(wet);
    wet.connect(output);
    delay.connect(fb);
    fb.connect(delay);
    delay.delayTime.value = params.time;
    fb.gain.value = params.feedback;
    wet.gain.value = params.mix;
    return {
      input,
      output,
      set(key, v) {
        const t = ctx.currentTime;
        if (key === 'time') delay.delayTime.setTargetAtTime(v, t, 0.01);
        else if (key === 'feedback') fb.gain.setTargetAtTime(v, t, 0.01);
        else if (key === 'mix') wet.gain.setTargetAtTime(v, t, 0.01);
      },
    };
  },
});
