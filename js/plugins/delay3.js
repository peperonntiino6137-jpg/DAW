'use strict';

// テンポ同期ディレイ（FL の Fruity Delay 3 風）
//
// 特徴:
//   - ディレイタイムを音価（1/16〜1/2、付点含む）で指定でき、BPM に追従する。
//     同期 OFF なら ms 指定。
//   - 帰還経路にローパスフィルタと軽いソフトクリップ（WaveShaper）を持ち、
//     繰り返すほど丸く歪んだ「テープ/アナログ」寄りの残響感になる。
//   - タイム変更時の応答を2モードから選べる（本プラグインの核）:
//       クロスフェード … ディレイラインを2系統持ち、待機側へ新タイムを仕込んで
//                         出力ゲインを短時間で入れ替える。クリックせず即座に切り替わる。
//       テープ風       … 稼働中ラインの delayTime を直線ランプ。読み出し速度が変わる
//                         あいだピッチが滑る（テープ機のバリスピ挙動）。
//   - ピンポン: 入力をモノ化して L へ入れ、帰還を L→R→L… と反対チャンネルへ
//     振り分けることでエコーが左右交互に跳ねる。
//   - dry/wet はホスト（FXスロットの MIX）が持つため、出力はウェット（エコー）のみ。
//
// ctx はライブ AudioContext / 書き出しの OfflineAudioContext の両方が渡る。
// AudioWorklet は使わないので prepare は不要。
(() => {
  // 音価テーブル（beats は4分音符=1拍としたときの拍数）
  const NOTES = [
    { label: '1/16',    beats: 0.25 },
    { label: '1/8',     beats: 0.5 },
    { label: '付点1/8', beats: 0.75 },
    { label: '1/4',     beats: 1 },
    { label: '付点1/4', beats: 1.5 },
    { label: '1/2',     beats: 2 },
  ];
  const MIN_T = 0.01;     // 最短ディレイ（帰還ループは仕様上 128 サンプル未満にならない）
  const MAX_T = 4;        // 最長ディレイ（低 BPM の 1/2 はここへクランプ）
  const XFADE = 0.08;     // クロスフェード長（秒）
  const TAPE_RAMP = 0.25; // テープ風のスライド時間（秒）
  const RAMP = 0.01;      // その他パラメータのライブ変更時定数

  // ---- BPM 変更のライブ追従 -------------------------------------------
  // 既存プラグインは BPM を参照していない（set() にも BPM は流れてこない）ため、
  // DAW.setBpm を一度だけ包み、生存中のライブインスタンスへ再計算を促す
  // 「update フック」方式にする。オフライン書き出しは create 時点の BPM を読めば
  // 十分（レンダリング中に BPM は変わらない）ので登録しない。
  // プロジェクト読み込みは bpm を直接代入するが、その際チェーンごと作り直される
  // ので create が新しい BPM を拾う。
  const liveRefs = new Set();   // WeakRef<再計算コールバック>（インスタンス破棄で自然に消える）
  const origSetBpm = DAW.setBpm.bind(DAW);
  DAW.setBpm = function (bpm) {
    const v = origSetBpm(bpm);
    for (const ref of [...liveRefs]) {
      const fn = ref.deref ? ref.deref() : ref;
      if (!fn) liveRefs.delete(ref);
      else fn();
    }
    return v;
  };

  // サチュレーションカーブ。小信号ゲイン1（tanh'(0)=1）のソフトクリップなので、
  // 帰還量と掛け合わせてもループゲインが 1 を超えず発振しない。amount=0 は素通し
  // （curve=null は WaveShaper の仕様でパススルー）。
  const satCurve = amount => {
    if (!(amount > 0)) return null;
    const k = 0.2 + 9.8 * amount;
    const n = 1025;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / k;
    }
    return c;
  };

  DAW.plugins.register({
    id: 'delay3',
    name: 'テンポ同期ディレイ',
    params: [
      { key: 'sync',     label: 'テンポ同期', min: 0, max: 1, step: 1, default: 1,
        format: v => (v >= 0.5 ? 'ON' : 'OFF') },
      { key: 'note',     label: '音価', min: 0, max: NOTES.length - 1, step: 1, default: 3,
        format: v => NOTES[Math.max(0, Math.min(NOTES.length - 1, Math.round(v)))].label },
      { key: 'timeMs',   label: '時間(同期OFF)', min: 10, max: 2000, step: 1, default: 300, unit: 'ms' },
      { key: 'feedback', label: '帰還', min: 0, max: 0.95, step: 0.01, default: 0.4 },
      { key: 'freq',     label: 'フィルタ', min: 200, max: 18000, step: 1, default: 4000, curve: 'log', unit: 'Hz' },
      { key: 'sat',      label: 'サチュレーション', min: 0, max: 1, step: 0.01, default: 0.15 },
      { key: 'mode',     label: 'タイム変更', min: 0, max: 1, step: 1, default: 0,
        format: v => (v >= 0.5 ? 'テープ風' : 'クロスフェード') },
      { key: 'pingpong', label: 'ピンポン', min: 0, max: 1, step: 1, default: 0,
        format: v => (v >= 0.5 ? 'ON' : 'OFF') },
    ],

    create(ctx, params) {
      const P = Object.assign({}, params);
      const input = ctx.createGain();
      const output = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      input.connect(split);
      merge.connect(output);

      // ---- チャンネルごとの帰還ループ ---------------------------------
      // loop(Gain, ループの合流点) → ディレイライン2系統 → tap(Gain)
      //   tap → merge（出力）
      //   tap → LPF → サチュレーション → 帰還量 → 自ch/反対ch へ振り分けて loop へ
      const loop = [ctx.createGain(), ctx.createGain()];
      const tap = [ctx.createGain(), ctx.createGain()];
      const lines = [];        // lines[ch][0|1] = { d: DelayNode, g: 出力ゲイン }
      for (let c = 0; c < 2; c++) {
        const pair = [];
        for (let k = 0; k < 2; k++) {
          const d = ctx.createDelay(MAX_T);
          const g = ctx.createGain();
          loop[c].connect(d);
          d.connect(g);
          g.connect(tap[c]);
          pair.push({ d, g });
        }
        lines.push(pair);
        tap[c].connect(merge, 0, c);
      }

      const lpf = [], shp = [], fbG = [], routeSelf = [], routeCross = [];
      for (let c = 0; c < 2; c++) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = P.freq;
        f.Q.value = 0.7071;
        const s = ctx.createWaveShaper();
        s.curve = satCurve(P.sat);
        const g = ctx.createGain();
        g.gain.value = P.feedback;
        tap[c].connect(f);
        f.connect(s);
        s.connect(g);
        const rs = ctx.createGain();   // 自チャンネルへ（通常ディレイ）
        const rc = ctx.createGain();   // 反対チャンネルへ（ピンポン）
        g.connect(rs); rs.connect(loop[c]);
        g.connect(rc); rc.connect(loop[1 - c]);
        lpf.push(f); shp.push(s); fbG.push(g); routeSelf.push(rs); routeCross.push(rc);
      }

      // 入力の振り分け: 通常は L→L / R→R。ピンポンは (L+R)/2 を L のループへだけ入れ、
      // 帰還のクロス配線で L→R→L… と跳ねさせる（各ホップで帰還量とフィルタを1回ずつ通る）。
      const inSelf = [ctx.createGain(), ctx.createGain()];
      const inMono = [ctx.createGain(), ctx.createGain()];
      for (let c = 0; c < 2; c++) {
        split.connect(inSelf[c], c);
        inSelf[c].connect(loop[c]);
        split.connect(inMono[c], c);
        inMono[c].connect(loop[0]);
      }

      const setG = (node, v, immediate) => {
        if (immediate || !ctx.currentTime) node.gain.value = v;
        else node.gain.setTargetAtTime(v, ctx.currentTime, RAMP);
      };
      const applyRouting = immediate => {
        const pp = P.pingpong >= 0.5;
        for (let c = 0; c < 2; c++) {
          setG(inSelf[c], pp ? 0 : 1, immediate);
          setG(inMono[c], pp ? 0.5 : 0, immediate);
          setG(routeSelf[c], pp ? 0 : 1, immediate);
          setG(routeCross[c], pp ? 1 : 0, immediate);
        }
      };

      // ---- ディレイタイム --------------------------------------------
      let active = 0;   // 現用ライン（クロスフェードで 0/1 が入れ替わる）
      let cur = 0;      // 現在の目標タイム（秒）
      const targetTime = () => {
        const bpm = (DAW.project && DAW.project.bpm) || 120;
        const sec = P.sync >= 0.5
          ? NOTES[Math.max(0, Math.min(NOTES.length - 1, Math.round(P.note)))].beats * 60 / bpm
          : P.timeMs / 1000;
        return Math.max(MIN_T, Math.min(MAX_T, sec));
      };
      const retime = immediate => {
        const T = targetTime();
        if (!immediate && Math.abs(T - cur) < 1e-9) return;
        const t = ctx.currentTime;
        if (immediate || !t) {
          // 構築時（オフラインの開始前を含む）: 両系統とも直接セット
          for (let c = 0; c < 2; c++) {
            for (const l of lines[c]) l.d.delayTime.value = T;
            lines[c][0].g.gain.value = active === 0 ? 1 : 0;
            lines[c][1].g.gain.value = active === 1 ? 1 : 0;
          }
        } else if (P.mode >= 0.5) {
          // テープ風: delayTime を直線ランプ。読み出し位置が滑って
          // 変化中はピッチが上下する（クリックはしない）
          for (let c = 0; c < 2; c++) for (const l of lines[c]) {
            const p = l.d.delayTime;
            p.cancelScheduledValues(t);
            p.setValueAtTime(p.value, t);
            p.linearRampToValueAtTime(T, t + TAPE_RAMP);
          }
        } else {
          // クロスフェード: 待機側ラインへ新タイムを仕込み（ゲイン0なので
          // delayTime のジャンプは聞こえない）、出力ゲインを直線で入れ替える
          const next = 1 - active;
          for (let c = 0; c < 2; c++) {
            const dt = lines[c][next].d.delayTime;
            dt.cancelScheduledValues(t);
            dt.value = T;
            const gN = lines[c][next].g.gain;
            const gO = lines[c][active].g.gain;
            for (const [g, target] of [[gN, 1], [gO, 0]]) {
              g.cancelScheduledValues(t);
              g.setValueAtTime(g.value, t);
              g.linearRampToValueAtTime(target, t + XFADE);
            }
          }
          active = next;
        }
        cur = T;
      };

      applyRouting(true);
      retime(true);

      const inst = {
        input,
        output,
        // テスト・デバッグ用: 現在の目標ディレイタイム（秒）
        currentDelaySec() { return cur; },
        set(key, v) {
          P[key] = v;
          const t = ctx.currentTime;
          if (key === 'feedback') for (const g of fbG) g.gain.setTargetAtTime(v, t, RAMP);
          else if (key === 'freq') for (const f of lpf) f.frequency.setTargetAtTime(v, t, RAMP);
          else if (key === 'sat') { const c = satCurve(v); for (const s of shp) s.curve = c; }
          else if (key === 'pingpong') applyRouting(false);
          else if (key === 'sync' || key === 'note' || key === 'timeMs') retime(false);
          // mode は保存のみ（次のタイム変更から効く）
        },
      };

      // ライブ ctx のときだけ BPM 変更フックへ登録。コールバックはインスタンスが
      // 保持し（_bpmCb）、インスタンスごと捨てられれば WeakRef 経由で自然に外れる。
      if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
        const cb = () => retime(false);
        inst._bpmCb = cb;
        liveRefs.add(typeof WeakRef !== 'undefined' ? new WeakRef(cb) : cb);
      }
      return inst;
    },
  });
})();
