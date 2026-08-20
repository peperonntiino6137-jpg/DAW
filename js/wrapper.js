'use strict';

// FL Studio 流エフェクトホストのラッパー層（フェーズ1）。
//
// 既存のプラグイン契約（DAW.plugins.register / create(ctx, params) → {input, output, set}）は
// 一切変えず、ホスト所有のノードで「外側から」包む移行アダプタ方式。
// プラグイン側は自分がラップされていることを知らなくてよい。
//
// スロットのグラフ:
//   slotIn(Gain) ─┬─ [dryDelay(latency>0 のみ)] → dryGain(1-wet) ─┐
//                 └─ inst.input … inst.output → wetGain(wet) ─────┴→ slotOut(Gain)
//
// - wet のクロスフェードは線形（dry=1-w / wet=w）。dry と wet は同一信号由来（相関）なので
//   線形和で振幅が一定になる。等パワー（√w）だと相関信号では中間で約+3dBの山が出るため使わない。
// - enable=false は inst 枝を slotIn から切り離して dry=1 にする。インスタンスは破棄しない
//   （再 enable が即時。リバーブの尾やコンプの状態も保てる）。
// - 切替・ドラッグ中の値変更は setTargetAtTime（時定数約10ms）でクリックを防ぐ。
//   構築時（オフライン書き出しを含む）は値を直接入れる（ランプの過渡を混ぜない）。
// - インスタンス契約に latencySamples（任意、既定0）を追加。latency>0 のスロットは
//   dry 枝に同量の DelayNode を入れてコムフィルタ化を防ぐ。トラック間 PDC の配線はフェーズ2
//   （今回は読み取り chainLatency() と dry 補償のみ）。
//
// スロットデータは track.effects の要素そのもの（稠密配列のまま。保存 version:1 据え置き）:
//   { pluginId, params, enabled: true(省略時true), wet: 1(省略時1) }
DAW.wrapper = {
  MAX_SLOTS: 10,   // 1トラックのスロット数（FXラックの行数）
  RAMP: 0.01,      // ライブ切替の setTargetAtTime 時定数（秒）。約10msでクリック防止

  // スロットを1つ作る。fx は track.effects の要素。未登録プラグインなら null。
  // 返り値は旧 connectChain のインスタンスと同じ input/output/set を持つので、
  // removeTrackNodes 等の既存の後始末コードがそのまま使える。
  createSlot(ctx, fx) {
    const def = DAW.plugins.get(fx.pluginId);
    if (!def) return null;
    const inst = def.create(ctx, fx.params);
    const latency = Math.max(0, Math.round(inst.latencySamples || 0));
    const slotIn = ctx.createGain();
    const slotOut = ctx.createGain();
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();

    // dry 枝。latency>0 のプラグインは同量の DelayNode で時間を揃える（混ぜてもコムにならない）。
    // enable=false でも外さない: 外すと切替のたびに dry のタイミングが跳ぶ。
    let dryHead = dryGain;
    if (latency > 0) {
      const d = ctx.createDelay(Math.max(1 / ctx.sampleRate, latency / ctx.sampleRate));
      d.delayTime.value = latency / ctx.sampleRate;
      d.connect(dryGain);
      dryHead = d;
    }
    slotIn.connect(dryHead);
    dryGain.connect(slotOut);

    // wet 枝の出口は常に繋いでおく（ゲイン0なら鳴らない）。入口 slotIn → inst.input だけを
    // enable で付け外しする（disable 中は処理そのものを止められる）。
    inst.output.connect(wetGain);
    wetGain.connect(slotOut);

    const slot = {
      input: slotIn,
      output: slotOut,
      inst,
      def,
      latencySamples: latency,
      _wet: fx.wet == null ? 1 : Math.max(0, Math.min(1, fx.wet)),
      _enabled: fx.enabled !== false,
      _connected: false,

      // dry/wet ゲインへの反映。immediate=true（構築時）は値を直接入れる。
      _apply(immediate) {
        const d = this._enabled ? 1 - this._wet : 1;
        const w = this._enabled ? this._wet : 0;
        if (immediate || !ctx.currentTime) {
          dryGain.gain.value = d;
          wetGain.gain.value = w;
        } else {
          const t = ctx.currentTime;
          dryGain.gain.setTargetAtTime(d, t, DAW.wrapper.RAMP);
          wetGain.gain.setTargetAtTime(w, t, DAW.wrapper.RAMP);
        }
      },

      _connect() {
        if (this._connected) return;
        slotIn.connect(inst.input);
        this._connected = true;
      },
      _disconnect() {
        if (!this._connected) return;
        try { slotIn.disconnect(inst.input); } catch (e) { /* 既に切れている */ }
        this._connected = false;
      },

      // enable の切替。インスタンスは破棄しない（再 enable 即時）。
      setEnabled(on, immediate) {
        this._enabled = !!on;
        if (this._enabled) this._connect();
        this._apply(immediate);
        if (!this._enabled) {
          if (immediate) {
            this._disconnect();
          } else {
            // wet がランプで落ちきってから入口を切る（切断そのものの段差を出さない）
            clearTimeout(this._offT);
            this._offT = setTimeout(() => { if (!this._enabled) this._disconnect(); }, 60);
          }
        }
      },

      // wet（MIX）の変更。0..1 に丸める。
      setWet(w, immediate) {
        this._wet = Math.max(0, Math.min(1, +w || 0));
        this._apply(immediate);
      },

      // パラメータのライブ変更はプラグインへそのまま委譲（契約は不変）
      set(key, value) {
        inst.set(key, value);
      },
    };
    if (slot._enabled) slot._connect();
    slot._apply(true);
    return slot;
  },

  // from(Gain) → スロット… → to を接続してスロット配列を返す。
  // 旧 DAW.audio.connectChain の中身（未登録 pluginId は従来どおり素通し）。
  buildChain(ctx, track, from, to) {
    let prev = from;
    const slots = [];
    for (const fx of track.effects) {
      const slot = this.createSlot(ctx, fx);
      if (!slot) continue;
      prev.connect(slot.input);
      prev = slot.output;
      slots.push(slot);
    }
    prev.connect(to);
    return slots;
  },

  // トラックのチェーン全体のレイテンシ（サンプル）。enable 中のスロットのみ加算する。
  // フェーズ1では読み取り専用（トラック間 PDC の配線はフェーズ2）。
  chainLatency(track) {
    const n = DAW.audio.trackNodes.get(track.id);
    if (!n || !n.fx) return 0;
    let sum = 0;
    for (const slot of n.fx) {
      if (slot && slot._enabled) sum += slot.latencySamples || 0;
    }
    return sum;
  },

  // ---- パラメータ記述子ユーティリティ ----
  // 記述子（def.params の要素）の任意拡張フィールド:
  //   { unit?, digits?, curve?: 'lin'|'log', format?(v) }
  // ノブ・ヒントバー・値入力は必ずここを通して同じ文字列/変換を使う。

  paramDef(def, key) {
    return (def && def.params && def.params.find(p => p.key === key)) || null;
  },

  // 実値 → 0..1。curve:'log' は対数スケール（周波数系。min>0 が前提）
  norm(def, key, v) {
    const p = this.paramDef(def, key);
    if (!p) return 0;
    const c = Math.max(p.min, Math.min(p.max, +v));
    if (p.curve === 'log' && p.min > 0) return Math.log(c / p.min) / Math.log(p.max / p.min);
    return (c - p.min) / (p.max - p.min);
  },

  // 0..1 → 実値（norm の逆）。step があればそのグリッドへ量子化する
  denorm(def, key, n) {
    const p = this.paramDef(def, key);
    if (!p) return 0;
    const t = Math.max(0, Math.min(1, +n));
    let v = (p.curve === 'log' && p.min > 0)
      ? p.min * Math.pow(p.max / p.min, t)
      : p.min + (p.max - p.min) * t;
    if (p.step > 0) v = Math.round(v / p.step) * p.step;
    return Math.max(p.min, Math.min(p.max, v));
  },

  // 表示用文字列（例: "8,000 Hz"）。format があればそれを優先する。
  formatValue(def, key, v) {
    const p = this.paramDef(def, key);
    if (!p) return String(v);
    if (p.format) return p.format(v);
    const digits = p.digits != null ? p.digits : this.stepDigits(p.step);
    const s = (+v).toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
    return p.unit ? `${s} ${p.unit}` : s;
  },

  // step から表示小数桁を推定する（step=1 → 0桁 / step=0.5 → 1桁 / step=0.01 → 2桁）
  stepDigits(step) {
    if (!(step > 0)) return 2;
    let d = 0;
    let s = step;
    while (d < 6 && Math.abs(s - Math.round(s)) > 1e-9) { s *= 10; d++; }
    return d;
  },
};
