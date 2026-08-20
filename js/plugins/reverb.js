'use strict';

// リバーブ。
// ConvolverNode に、指数的に減衰するノイズのインパルス応答を合成して渡す。
//
// 重要: 乱数は固定シードの線形合同法で作る。Math.random を使うと
// 再生時と書き出し時で違う残響になり、「聞いた音と書き出した音が違う」ことになる。
DAW.plugins.register({
  id: 'reverb',
  name: 'リバーブ',
  params: [
    { key: 'decay', label: '残響長', min: 0.2, max: 4, step: 0.1, default: 1.6 },
    { key: 'damp', label: '減衰カーブ', min: 1, max: 6, step: 0.1, default: 2.5 },
    { key: 'mix', label: 'ミックス', min: 0, max: 1, step: 0.01, default: 0.3 },
  ],

  // 固定シードのノイズから作るので、同じパラメータなら常に同じ残響になる
  impulse(ctx, decay, damp) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * decay));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    let seed = 20250820;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;   // 線形合同法
      return seed / 0x100000000 * 2 - 1;
    };
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = rnd() * Math.pow(1 - i / len, damp);
    }
    return buf;
  },

  create(ctx, params) {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const output = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = this.impulse(ctx, params.decay, params.damp);

    dry.gain.value = 1 - params.mix;
    wet.gain.value = params.mix;
    input.connect(dry);
    input.connect(conv);
    conv.connect(wet);
    dry.connect(output);
    wet.connect(output);

    const self = this;
    const cur = { decay: params.decay, damp: params.damp };
    return {
      input,
      output,
      set(key, v) {
        if (key === 'mix') {
          dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01);
          wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          return;
        }
        // 残響長・減衰カーブはインパルス応答の作り直しが要る
        cur[key] = v;
        conv.buffer = self.impulse(ctx, cur.decay, cur.damp);
      },
    };
  },
});
