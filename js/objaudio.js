'use strict';

// オブジェクトの音を実際に鳴らす層（レンダラー）。
//
// 核心は「同じオブジェクト state から、出力形式（バイノーラル / スピーカー）を差し替えられる」こと。
// ここでは 2 つのモードを持つ:
//   equalpower … 等パワーの L/R パン。軽いので編集中はこちら（CPU 対策）
//   hrtf       … PannerNode(HRTF)。試聴時だけ切り替える
// VBAP（5.1 / 7.1.4）は RENDERER 画面と同時に足す。ここに mode を増やす形になる。
//
// 極座標 → 直交座標の変換は **この層だけ** で行う（UI と保存形式は極座標のまま）。
DAW.objaudio = {
  MODE_EQUALPOWER: 'equalpower',
  MODE_HRTF: 'hrtf',
  MODE_SPEAKERS: 'speakers',
  mode: 'equalpower',

  // スピーカー配置（ADM 準拠の az/el）。並び順はそのまま WAV のチャンネル順になる
  // （5.1 は L, R, C, LFE, Ls, Rs の標準順）。
  LAYOUTS: {
    '2.0': [
      { name: 'L', az: 30, el: 0 },
      { name: 'R', az: -30, el: 0 },
    ],
    '5.1': [
      { name: 'L', az: 30, el: 0 },
      { name: 'R', az: -30, el: 0 },
      { name: 'C', az: 0, el: 0 },
      { name: 'LFE', az: 0, el: -30, lfe: true },
      { name: 'Ls', az: 110, el: 0 },
      { name: 'Rs', az: -110, el: 0 },
    ],
    '7.1.4': [
      { name: 'L', az: 30, el: 0 },
      { name: 'R', az: -30, el: 0 },
      { name: 'C', az: 0, el: 0 },
      { name: 'LFE', az: 0, el: -30, lfe: true },
      { name: 'Lss', az: 90, el: 0 },
      { name: 'Rss', az: -90, el: 0 },
      { name: 'Lrs', az: 135, el: 0 },
      { name: 'Rrs', az: -135, el: 0 },
      { name: 'Ltf', az: 45, el: 45 },
      { name: 'Rtf', az: -45, el: 45 },
      { name: 'Ltr', az: 135, el: 45 },
      { name: 'Rtr', az: -135, el: 45 },
    ],
    // 13ch（WalkMix リファレンス互換）: 耳高5本 + 上層(+30°)5本 + 下層(-20°)3本。LFE なし。
    // 上層は耳高と同じ方位、下層は前方3本。下層があるので el<0 も実際に定位できる
    // （vbapGains の N 層一般化が前提。2層時代の el<0 → 0 クランプでは鳴らない）。
    '5.0.5.3': [
      { name: 'L', az: 30, el: 0 },
      { name: 'R', az: -30, el: 0 },
      { name: 'C', az: 0, el: 0 },
      { name: 'Ls', az: 110, el: 0 },
      { name: 'Rs', az: -110, el: 0 },
      { name: 'Lt', az: 30, el: 30 },
      { name: 'Rt', az: -30, el: 30 },
      { name: 'Ct', az: 0, el: 30 },
      { name: 'Lst', az: 110, el: 30 },
      { name: 'Rst', az: -110, el: 30 },
      { name: 'Lb', az: 30, el: -20 },
      { name: 'Rb', az: -30, el: -20 },
      { name: 'Cb', az: 0, el: -20 },
    ],
  },
  layoutName: '5.1',

  layout() {
    return this.LAYOUTS[this.layoutName] || this.LAYOUTS['5.1'];
  },

  setLayout(name) {
    if (!this.LAYOUTS[name] || name === this.layoutName) return false;
    this.layoutName = name;
    if (this.mode === this.MODE_SPEAKERS) {
      DAW.audio.resetNodes();
      DAW.audio.reschedule();
    }
    return true;
  },

  // 出力チャンネル数。バイノーラル/等パワーは 2、スピーカー出力は配置のスピーカー数。
  outputChannels() {
    return this.mode === this.MODE_SPEAKERS ? this.layout().length : 2;
  },

  // ---- 出力形式の保存/復元（プロジェクト保存用）----
  //
  // 保存するのは「ユーザーの明示選択」= バイノーラル / スピーカーの別と配置だけ。
  // equalpower / hrtf の別は autoHrtf の自動切替（試聴中だけ HRTF）が決める一時状態なので、
  // 保存した瞬間のモードを固定すると復元時に自動切替と食い違う。UI（objui.OUT_MODES）と
  // 同じ2値に落として保存し、復元後の等パワー ↔ HRTF は従来どおり自動切替に任せる。
  OUTPUT_DEFAULTS: { mode: 'binaural', layout: '5.1' },

  outputToJSON() {
    return {
      mode: this.mode === this.MODE_SPEAKERS ? 'speakers' : 'binaural',
      layout: this.layoutName,
    };
  },

  // プロジェクト読み込み用。欠落や未知の値は既定値（バイノーラル / 5.1）で補完する。
  // バイノーラルはまず軽い等パワーへ入れる（試聴時の HRTF 化は autoHrtf が担う）。
  loadOutput(src) {
    const s = src && typeof src === 'object' ? src : {};
    this.layoutName = this.LAYOUTS[s.layout] ? s.layout : this.OUTPUT_DEFAULTS.layout;
    this.setModeQuiet(s.mode === 'speakers' ? this.MODE_SPEAKERS : this.MODE_EQUALPOWER);
  },

  live: new Map(),   // objId -> ノード一式（ライブ用。オフライン書き出しでは保持しない）

  // 書き出し中のレンダリング範囲 {from, until}（プロジェクト絶対時間）。
  // wav.js の exportMix がグラフを組む間だけ設定し、終わったら null に戻す。
  // オフライン ctx での create() がこれを見て経路をランプ列に焼き込む。
  exportRange: null,
  PATH_BAKE_DT: 0.02,   // 経路焼き込みのサンプリング間隔（20ms 固定）

  // 試聴時だけ HRTF にする（編集中は等パワーで軽く保つ）。CPU 対策なので既定で有効。
  autoHrtf: true,
  editing: false,    // ビューでドラッグ中など、編集操作の最中か

  // ---- ルームリバーブ（オブジェクト共有のセンドバス）----
  //
  // 各オブジェクトの「ゲイン後・定位前」の点から sendGain で1本のバスへ集約し、
  // ConvolverNode（生成 IR）を通してオブジェクトミックスと同じ出力（マスター、
  // リミッター前）へ合流させる。トラック FX のリバーブ（インサート）とは独立の空間側の機構。
  //
  // 実効センド量は距離と連動させ、「遠くのオブジェクトほど残響が多い」＝距離が耳で分かるようにする:
  //   実効センド量 = revSend × (0.25 + 0.75 × dist)
  // 式はここ（revSendLevel）に1箇所だけ持つ。ライブ（followPaths / update）も
  // 書き出し（bakePath のランプ焼き込み）も必ずこれを通す。
  //
  // level=0（リターン無し）や revSend=0 のときは無音（正確な 0.0）を足すだけなので、
  // 既存の音とサンプル一致する（回帰の要。既定 level=0 で旧プロジェクトの音を変えない）。
  REV_LIMITS: {
    decay: [0.2, 6],     // 残響長（秒）
    damp: [0.05, 1],     // 明るさ（1 = 明るい。IR のノイズへ掛ける1次ローパスの係数）
    level: [0, 1],       // リターン量（0 = リバーブなし = 既存の音と完全一致）
  },
  REV_DEFAULTS: { decay: 1.8, damp: 0.5, level: 0 },
  revParams: { decay: 1.8, damp: 0.5, level: 0 },
  _revBuses: new WeakMap(),   // ctx -> バス一式（ライブ/オフラインの ctx ごとに1つ）

  // 実効センド量（この式が距離連動の定義。ここ以外に持たない）
  revSendLevel(obj, dist) {
    const d = Math.max(0, Math.min(1, dist == null ? obj.dist : dist));
    return (obj.revSend || 0) * (0.25 + 0.75 * d);
  },

  // ルームリバーブのインパルス応答。js/plugins/reverb.js と同じく固定シードの
  // 線形合同法ノイズから作る（Math.random だと再生と書き出しで残響が変わってしまう）。
  // damp（明るさ）は1次ローパス y += a(x - y) の係数 a。小さいほど高域が落ちて暗くなる。
  // 減衰エンベロープは (1 - i/len)^2.5 で固定（長さは decay が受け持つ）。
  revImpulse(ctx, decay, damp) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * decay));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    let seed = 20260820;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;   // 線形合同法
      return seed / 0x100000000 * 2 - 1;
    };
    const a = Math.max(0.01, Math.min(1, damp));
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        y += a * (rnd() - y);                       // 明るさ（1次ローパス）
        d[i] = y * Math.pow(1 - i / len, 2.5);      // 減衰エンベロープ
      }
    }
    return buf;
  },

  // ctx ごとの共有バスを（無ければ作って）返す。dest はオブジェクトミックスと同じ出力先。
  // バイノーラル/等パワーではステレオのまま合流し、スピーカー（VBAP）では
  // リバーブ L → 左側スピーカー群（az>0・LFE除く）、R → 右側（az<0）へ 1/√n で等分配する
  // （C と LFE には送らない。チャンネル数は配置と一致する）。
  ensureRevBus(ctx, dest) {
    let bus = this._revBuses.get(ctx);
    if (bus) return bus;
    const input = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = this.revImpulse(ctx, this.revParams.decay, this.revParams.damp);
    const wet = ctx.createGain();
    wet.gain.value = this.revParams.level;
    input.connect(conv);
    conv.connect(wet);
    const nodes = [input, conv, wet];
    if (this.mode === this.MODE_SPEAKERS) {
      const layout = this.layout();
      const split = ctx.createChannelSplitter(2);
      wet.connect(split);
      const merger = ctx.createChannelMerger(layout.length);
      const sides = [[], []];   // [左（az>0）, 右（az<0）] のチャンネル番号
      layout.forEach((s, i) => { if (!s.lfe && s.az !== 0) sides[s.az > 0 ? 0 : 1].push(i); });
      for (let side = 0; side < 2; side++) {
        const k = sides[side].length ? 1 / Math.sqrt(sides[side].length) : 0;
        for (const i of sides[side]) {
          const g = ctx.createGain();
          g.gain.value = k;
          split.connect(g, side);   // ch0 = リバーブ L → 左側、ch1 = R → 右側
          g.connect(merger, 0, i);
          nodes.push(g);
        }
      }
      merger.connect(dest);
      nodes.push(split, merger);
    } else {
      wet.connect(dest);   // ステレオのまま合流
    }
    bus = { input, conv, wet, nodes };
    this._revBuses.set(ctx, bus);
    return bus;
  },

  // マスターパラメータの変更（RENDERER のノブから）。level は即時、
  // decay / damp は IR の作り直しが要る（js/plugins/reverb.js の set と同じ作法）。
  setRevParam(key, value) {
    const r = this.REV_LIMITS[key];
    if (!r) return false;
    const n = +value;
    this.revParams[key] = Math.max(r[0], Math.min(r[1], isFinite(n) ? n : this.REV_DEFAULTS[key]));
    const ctx = DAW.audio && DAW.audio.ctx;
    const bus = ctx && this._revBuses.get(ctx);
    if (bus) {
      if (key === 'level') bus.wet.gain.setTargetAtTime(this.revParams.level, ctx.currentTime, 0.01);
      else bus.conv.buffer = this.revImpulse(ctx, this.revParams.decay, this.revParams.damp);
    }
    return true;
  },

  // プロジェクト読み込み用。欠落は既定値で補完する（旧プロジェクトは level=0 で音が変わらない）
  loadRevParams(src) {
    const s = src && typeof src === 'object' ? src : {};
    for (const key of Object.keys(this.REV_LIMITS)) {
      this.setRevParam(key, s[key] != null ? s[key] : this.REV_DEFAULTS[key]);
    }
  },

  // ライブのバスを切り離して捨てる（reset から呼ぶ。オフライン ctx は丸ごと破棄されるので不要）
  resetRevBus() {
    const ctx = DAW.audio && DAW.audio.ctx;
    const bus = ctx && this._revBuses.get(ctx);
    if (!bus) return;
    for (const nd of bus.nodes) { try { nd.disconnect(); } catch (e) {} }
    this._revBuses.delete(ctx);
  },

  // トラックに割り当てられたオブジェクト（未割り当てなら null）
  forTrack(trackId) {
    if (!trackId) return null;
    return DAW.objects.list.find(o => o.trackId === trackId) || null;
  },

  // 極座標 → 直交座標（ラジアン換算）。Web Audio のリスナーは -z を向いているので、
  //   az=0（正面）で z=-1、az=+90（ADM では左）で x=-1 になる。
  toCartesian(az, el, dist) {
    const rad = Math.PI / 180;
    const a = (az || 0) * rad;
    const e = (el || 0) * rad;
    const d = dist == null ? 1 : dist;
    return {
      x: -Math.sin(a) * Math.cos(e) * d,
      y: Math.sin(e) * d,
      z: -Math.cos(a) * Math.cos(e) * d,
    };
  },

  // 等パワーパンの L/R ゲイン。
  // ADM は「正 = 左」なので、az=+90 で左いっぱい、az=-90 で右いっぱいになる。
  // 仰角が上がるほど左右差を減らす（真上の音は左右中央に聞こえるため）。
  panGains(az, el) {
    const rad = Math.PI / 180;
    const p = -Math.sin((az || 0) * rad) * Math.cos((el || 0) * rad);   // -1(左) 〜 +1(右)
    const t = (p + 1) * Math.PI / 4;                                     // 0 〜 π/2
    return { l: Math.cos(t), r: Math.sin(t) };
  },

  // 方位の差を (-180, 180] に畳む
  azDelta(a, b) {
    let d = a - b;
    d = ((d % 360) + 360) % 360;
    return d > 180 ? d - 360 : d;
  },

  // 層（同じ仰角帯のスピーカー群）の中で、方位を挟む2本を見つけてペアパンニングする。
  // 正確な3D VBAP は三角形分割が要るが、実運用の配置は層構造なので
  // 「層内はペアVBAP、層間は仰角で等パワークロスフェード」で十分な精度が出る。
  layerGains(az, speakers) {
    const g = new Map();
    if (!speakers.length) return g;
    if (speakers.length === 1) {
      g.set(speakers[0], 1);
      return g;
    }
    // 方位順に並べ、az を挟む隣接ペアを探す
    const sorted = speakers.slice().sort((a, b) => a.az - b.az);
    let lo = null, hi = null, best = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[(i + 1) % sorted.length];
      const span = ((this.azDelta(b.az, a.az) + 360) % 360) || 360;   // a から b への左回り角
      const t = ((this.azDelta(az, a.az) + 360) % 360);
      if (t <= span + 1e-9 && span < best) { lo = a; hi = b; best = span; }
    }
    if (!lo) { lo = sorted[0]; hi = sorted[0]; best = 1; }
    const t = Math.min(1, Math.max(0, ((this.azDelta(az, lo.az) + 360) % 360) / (best || 1)));
    const ang = t * Math.PI / 2;
    if (lo === hi) {
      g.set(lo, 1);
    } else {
      g.set(lo, Math.cos(ang));
      g.set(hi, Math.sin(ang));
    }
    return g;
  },

  _layerCache: new WeakMap(),   // layout 配列 -> 層分割（毎回のソートを避ける。bakePath で多数回呼ぶため）

  // 配置を仰角の層に分ける（LFE 除外・仰角の低い順）。仰角差が 10° 未満の連なりを同じ層とみなす。
  // 5.1 は1層(0°)、7.1.4 は2層(0°/45°)、5.0.5.3 は3層(-20°/0°/+30°)になる。
  // 層の代表仰角 el は所属スピーカーの平均（7.1.4 の従来値 0°/45° と一致し、既存出力を変えない）。
  vbapLayers(layout) {
    let layers = this._layerCache.get(layout);
    if (layers) return layers;
    const spk = layout.filter(s => !s.lfe).sort((a, b) => a.el - b.el);
    layers = [];
    for (const s of spk) {
      const last = layers[layers.length - 1];
      if (last && s.el - last.spk[last.spk.length - 1].el < 10) last.spk.push(s);
      else layers.push({ spk: [s] });
    }
    for (const L of layers) L.el = L.spk.reduce((a, s) => a + s.el, 0) / L.spk.length;
    this._layerCache.set(layout, layers);
    return layers;
  },

  // オブジェクト位置 → 各スピーカーのゲイン配列（配置の並び順）。パワー和は 1。
  // 層数非依存: el を挟む隣接2層を等パワークロスフェードし、層内は layerGains のペア VBAP。
  // 範囲外の el は端の層へクランプする（5.1 のように1層なら仰角は表現できず水平面へ落ちる。
  // 2層の 7.1.4 では従来の「水平0° 〜 上層45°」の式と厳密に同じ値になる = 回帰なし）。
  vbapGains(az, el, layout) {
    const layers = this.vbapLayers(layout);
    const gains = new Map();
    const addAll = (m, w) => {
      for (const [s, v] of m) gains.set(s, (gains.get(s) || 0) + v * w);
    };
    // el を挟む隣接ペア [lo, hi] を探す（下に外れたら最下層のみ、上に外れたら最上層のみ）
    let lo = layers[0], hi = layers[layers.length - 1];
    if (el <= lo.el) hi = lo;
    else if (el >= hi.el) lo = hi;
    else {
      for (let i = 0; i < layers.length - 1; i++) {
        if (el >= layers[i].el && el <= layers[i + 1].el) { lo = layers[i]; hi = layers[i + 1]; break; }
      }
    }
    if (lo === hi) {
      addAll(this.layerGains(az, lo.spk), 1);
    } else {
      const t = (el - lo.el) / (hi.el - lo.el);          // 0 = 下の層、1 = 上の層
      const ang = t * Math.PI / 2;
      addAll(this.layerGains(az, lo.spk), Math.cos(ang));
      addAll(this.layerGains(az, hi.spk), Math.sin(ang));
    }
    // パワー正規化（層間クロスフェードで誤差が出ても 1 に揃える）
    let sum = 0;
    for (const v of gains.values()) sum += v * v;
    const norm = sum > 0 ? 1 / Math.sqrt(sum) : 0;
    return layout.map(s => (gains.get(s) || 0) * norm);
  },

  // 1点ぶんの定位チェーン。出力形式（等パワー / HRTF / スピーカー）の違いはここに閉じ込める。
  // width で2ソースに分ける場合は、これを2つ作って左右に振り分ける。
  createPoint(ctx, src, az, el, dist, dest) {
    const p = { az, el, dist, panner: null, gl: null, gr: null, spk: null, output: null };
    if (this.mode === this.MODE_HRTF) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;      // dist は 0〜1 なので、この範囲では距離減衰しない
      panner.maxDistance = 10000;
      panner.rolloffFactor = 1;
      this.applyPosition(panner, { az, el, dist }, ctx);
      src.connect(panner);
      p.panner = panner;
      p.output = panner;
    } else if (this.mode === this.MODE_SPEAKERS) {
      const layout = this.layout();
      const gains = this.vbapGains(az, el, layout);
      const merger = ctx.createChannelMerger(layout.length);
      p.spk = [];
      for (let i = 0; i < layout.length; i++) {
        const sg = ctx.createGain();
        sg.gain.value = gains[i];
        src.connect(sg);
        sg.connect(merger, 0, i);
        p.spk.push(sg);
      }
      p.output = merger;
    } else {
      const g = this.panGains(az, el);
      const gl = ctx.createGain();
      const gr = ctx.createGain();
      gl.gain.value = g.l;
      gr.gain.value = g.r;
      const merger = ctx.createChannelMerger(2);
      src.connect(gl);
      src.connect(gr);
      gl.connect(merger, 0, 0);
      gr.connect(merger, 0, 1);
      p.gl = gl;
      p.gr = gr;
      p.output = merger;
    }
    p.output.connect(dest);
    return p;
  },

  updatePoint(p, az, el, dist, t) {
    p.az = az; p.el = el; p.dist = dist;
    if (p.panner) {
      const c = this.toCartesian(az, el, dist);
      if (p.panner.positionX) {
        p.panner.positionX.setTargetAtTime(c.x, t, 0.02);
        p.panner.positionY.setTargetAtTime(c.y, t, 0.02);
        p.panner.positionZ.setTargetAtTime(c.z, t, 0.02);
      } else {
        p.panner.setPosition(c.x, c.y, c.z);
      }
    } else if (p.spk) {
      const gains = this.vbapGains(az, el, this.layout());
      for (let i = 0; i < p.spk.length && i < gains.length; i++) p.spk[i].gain.setTargetAtTime(gains[i], t, 0.02);
    } else if (p.gl) {
      const g = this.panGains(az, el);
      p.gl.gain.setTargetAtTime(g.l, t, 0.02);
      p.gr.gain.setTargetAtTime(g.r, t, 0.02);
    }
  },

  // width(%) → 広がりの角度。100% で 90°（±45°）、200% で 180°（±90°）。
  spreadAngle(width) {
    return Math.min(180, Math.abs(width || 0) / 100 * 90);
  },

  // 2ソースに分けたときの各ソースの振幅。
  // 単純に 0.5 ずつにすると、モノラル素材（2ソースが同相で足し合わさる）の音量が
  // width を広げるほど下がってしまう（±90°で -3dB）。
  // そこで「両ソースのゲインを足したベクトルのパワーが 1 になる」ように正規化する。
  // width=0 の点音源（各ch 0.707）と連続的につながり、モノラル素材なら音量が変わらない。
  widthGain(obj) {
    const az = this.widthAzimuths(obj);
    const a = this.panGains(az.left, obj.el);
    const b = this.panGains(az.right, obj.el);
    const l = a.l + b.l;
    const r = a.r + b.r;
    const p = Math.sqrt(l * l + r * r);
    return p > 0 ? 1 / p : 0.5;
  },

  // width を考慮した2点の方位。正なら L 成分が左（az+half）、負なら L/R が入れ替わる。
  widthAzimuths(obj) {
    const half = this.spreadAngle(obj.width) / 2;
    const sign = (obj.width || 0) >= 0 ? 1 : -1;
    return { left: obj.az + half * sign, right: obj.az - half * sign };
  },

  // オブジェクト1つぶんのチェーンを作る。ライブ用の ctx でもオフライン（書き出し）でも同じものを通す。
  //
  // width = 0 … 点音源。入口でモノラルへ畳んでから1点に定位させる。
  // width ≠ 0 … 2ソースに分ける（MDAP）。入力の L/R を別々の方位へ振り分けるので、
  //             ステレオ素材は左右の内容がそのまま広がり、モノラル素材は同じ音が両側に出る。
  //             負の width は L/R を入れ替える（仕様どおり）。
  //             各ソースの振幅は 0.5。モノラル素材なら合計が元と同じになり、
  //             width を動かしても音量が跳ねない（width=0 の (L+R)/2 とも整合する）。
  create(ctx, obj, dest) {
    const input = ctx.createGain();
    const gain = ctx.createGain();
    gain.gain.value = DAW.objects.effectiveGain(obj);
    input.connect(gain);

    const nodes = { input, gain, points: [], output: null, mode: this.mode, analyser: null, width: obj.width || 0, rev: null };
    // ルームリバーブのセンド。ゲイン後・定位前の点から共有バスへ送る。
    // 実効量（revSendLevel）は距離連動。経路で dist が動く場合、ライブは
    // applyObjPosition（update / followPaths）、書き出しは bakePath が追従させる。
    {
      const rev = ctx.createGain();
      rev.gain.value = this.revSendLevel(obj, obj.dist);
      gain.connect(rev);
      rev.connect(this.ensureRevBus(ctx, dest).input);
      nodes.rev = rev;
    }
    // ライブのときだけメーター用の分岐を作る（書き出しでは不要な負荷）。
    // 128個ぶん常時読むと重いので、読むのは可視ストリップだけ（peakDb() を呼んだときに計測する）。
    if (ctx === DAW.audio.ctx) {
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      gain.connect(an);
      nodes.analyser = an;
      nodes.meterBuf = new Float32Array(an.fftSize);
    }

    if (!nodes.width) {
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';   // ステレオ素材は (L+R)/2 に畳まれる
      gain.connect(mono);
      nodes.points.push(this.createPoint(ctx, mono, obj.az, obj.el, obj.dist, dest));
    } else {
      // ChannelSplitter は既定が discrete なので、モノラル入力だと ch1 が無音になる。
      // speakers 解釈にして「モノラルは L=R に複製」させる（モノラル素材も両側へ広がる）。
      const stereo = ctx.createGain();
      stereo.channelCount = 2;
      stereo.channelCountMode = 'explicit';
      stereo.channelInterpretation = 'speakers';
      const split = ctx.createChannelSplitter(2);
      gain.connect(stereo);
      stereo.connect(split);
      const az = this.widthAzimuths(obj);
      const k = this.widthGain(obj);
      const mk = (chIndex, azimuth) => {
        const g = ctx.createGain();
        g.gain.value = k;
        split.connect(g, chIndex);
        const pt = this.createPoint(ctx, g, azimuth, obj.el, obj.dist, dest);
        pt.src = g;   // width 変更時に振幅を追従させるため覚えておく
        return pt;
      };
      nodes.points.push(mk(0, az.left));    // L 成分
      nodes.points.push(mk(1, az.right));   // R 成分
    }
    nodes.output = nodes.points[0].output;
    // 書き出し（オフライン ctx）で経路が有効なら、位置の時間変化をランプ列として焼き込む。
    // ライブは rAF 追従（followPaths）、書き出しはこの焼き込み、と経路の反映方法を分ける
    // （オフラインレンダリングには rAF が無いため）。
    if (ctx !== (DAW.audio && DAW.audio.ctx) && this.exportRange
        && obj.path && obj.path.enabled && obj.path.points.length) {
      this.bakePath(ctx, nodes, obj, this.exportRange.from, this.exportRange.until);
    }
    return nodes;
  },

  // ---- 経路の焼き込み（書き出し用）----

  // サンプリング時刻の列（プロジェクト絶対時間・昇順・重複なし）。
  // 動いている区間（最初の点〜最後の点）だけ PATH_BAKE_DT 刻み + 各 waypoint 時刻。
  // 前後のホールド区間は値が変わらないので端の2イベントに省略される（刻みを入れない）。
  // loop 有効時は最後の点以降も動き続けるので、until まで刻みを続け、waypoint 時刻も
  // 周回ごとに展開する（折り返し境界 = 先頭点の時刻も各周回に入る。位置は pathPosAt が
  // 剰余で返すため、焼き込んだランプはライブの追従とサンプル時刻ごとに一致する）。
  bakeTimes(pts, from, until, loop) {
    const ts = [from, until];
    const t0 = pts[0].t;
    const span = pts[pts.length - 1].t - t0;
    const looped = !!loop && span > 0;
    const m0 = Math.max(from, t0);
    const m1 = looped ? until : Math.min(until, pts[pts.length - 1].t);
    // 加算の誤差が積もらないよう k * DT で刻む（waypoint 時刻と紛らわしい端数を出さない）
    for (let k = 0; ; k++) {
      const t = m0 + k * this.PATH_BAKE_DT;
      if (t >= m1 - 1e-9) break;
      ts.push(t);
    }
    if (looped) {
      // from より前の周回は飛ばしてから、until まで各周回の waypoint 時刻を並べる
      let base = t0;
      if (from > base) base += Math.floor((from - base) / span) * span;
      for (; base < until; base += span) {
        for (const p of pts) {
          const t = base + (p.t - t0);
          if (t > from && t < until) ts.push(t);
        }
      }
    } else {
      for (const p of pts) {
        if (p.t > from && p.t < until) ts.push(p.t);
      }
    }
    ts.sort((a, b) => a - b);
    const out = [];
    for (const t of ts) {
      if (!out.length || t - out[out.length - 1] > 1e-6) out.push(t);
    }
    return out;
  },

  // 経路をオフライン ctx の AudioParam へ setValueAtTime + linearRampToValueAtTime 列で予約する。
  // 位置の値計算はライブ側と同じ式（toCartesian / panGains / vbapGains / widthAzimuths / widthGain）
  // を使うので、「聞いた音」と「書き出した音」の定位は一致する。
  // ctx の時刻 0 = プロジェクト時刻 from（exportMix は from を起点にクリップを並べる）。
  bakePath(ctx, nodes, obj, from, until) {
    const pts = obj.path && obj.path.points;
    if (!pts || !pts.length || !(until > from)) return;
    const layout = this.layout();
    // パラメータと「位置 → 値」の対を集める。width ≠ 0 は2点それぞれ（L は az.left、R は az.right）。
    const params = [];
    const calc = [];
    const addPoint = (p, side) => {
      const azOf = pos => {
        if (!side) return pos.az;
        const az = this.widthAzimuths({ az: pos.az, width: obj.width });
        return side === 'L' ? az.left : az.right;
      };
      if (p.src) {   // 2ソースの振幅（widthGain は方位で変わるので一緒に焼く）
        params.push(p.src.gain);
        calc.push(pos => this.widthGain({ az: pos.az, el: pos.el, width: obj.width }));
      }
      if (p.panner) {
        if (!p.panner.positionX) return;   // 古い実装（setPosition のみ）は焼き込めず初期位置のまま
        params.push(p.panner.positionX, p.panner.positionY, p.panner.positionZ);
        calc.push(
          pos => this.toCartesian(azOf(pos), pos.el, pos.dist).x,
          pos => this.toCartesian(azOf(pos), pos.el, pos.dist).y,
          pos => this.toCartesian(azOf(pos), pos.el, pos.dist).z,
        );
      } else if (p.spk) {
        p.spk.forEach((sg, i) => {
          params.push(sg.gain);
          calc.push(pos => this.vbapGains(azOf(pos), pos.el, layout)[i]);
        });
      } else if (p.gl) {
        params.push(p.gl.gain, p.gr.gain);
        calc.push(
          pos => this.panGains(azOf(pos), pos.el).l,
          pos => this.panGains(azOf(pos), pos.el).r,
        );
      }
    };
    if (nodes.points.length === 1) {
      addPoint(nodes.points[0], null);
    } else {
      addPoint(nodes.points[0], 'L');
      addPoint(nodes.points[1], 'R');
    }
    // ルームリバーブのセンドも距離連動なので、経路の dist の動きを一緒に焼き込む
    if (nodes.rev) {
      params.push(nodes.rev.gain);
      calc.push(pos => this.revSendLevel(obj, pos.dist));
    }
    const times = this.bakeTimes(pts, from, until, obj.path.loop);
    for (let i = 0; i < times.length; i++) {
      const pos = DAW.objects.pathPosAt(obj, times[i]);
      const ct = Math.max(0, times[i] - from);
      for (let k = 0; k < params.length; k++) {
        const v = calc[k](pos);
        if (i === 0) params[k].setValueAtTime(v, ct);
        else params[k].linearRampToValueAtTime(v, ct);
      }
    }
  },

  // PannerNode へ位置を反映する。positionX/Y/Z は AudioParam なので、
  // 将来の位置オートメーションはここにキーフレーム → ランプ変換を挟む。
  applyPosition(panner, obj, ctx) {
    const p = this.toCartesian(obj.az, obj.el, obj.dist);
    if (panner.positionX) {
      const t = ctx ? ctx.currentTime : 0;
      panner.positionX.setValueAtTime(p.x, t);
      panner.positionY.setValueAtTime(p.y, t);
      panner.positionZ.setValueAtTime(p.z, t);
    } else {
      panner.setPosition(p.x, p.y, p.z);   // 古い実装向けのフォールバック
    }
  },

  // ライブ用のノードを覚えておく（後からパラメータだけ更新できるように）
  remember(objId, nodes) {
    this.live.set(objId, nodes);
  },

  // 位置 pos = {az, el, dist} をノード一式へ反映する。update() から抽出した共通経路で、
  // update()（パラメータ変更）と followPaths()（経路のライブ追従）が同じここを通る
  // （書き出しの bakePath も同じ値計算 = widthAzimuths / widthGain / updatePoint の式を使う）。
  // width ≠ 0 の2ソース分岐（widthAzimuths / widthGain）もここに閉じ込める。
  applyObjPosition(nodes, obj, pos, t) {
    // ルームリバーブのセンドは距離連動（revSendLevel）。位置と同じ滑らかさで追従させる
    if (nodes.rev) nodes.rev.gain.setTargetAtTime(this.revSendLevel(obj, pos.dist), t, 0.02);
    if (nodes.points.length === 1) {
      this.updatePoint(nodes.points[0], pos.az, pos.el, pos.dist, t);
    } else {
      const w = { az: pos.az, el: pos.el, width: obj.width };   // widthAzimuths/widthGain は obj 形を読む
      const az = this.widthAzimuths(w);
      const k = this.widthGain(w);
      for (const p of nodes.points) if (p.src) p.src.gain.setTargetAtTime(k, t, 0.02);
      this.updatePoint(nodes.points[0], az.left, pos.el, pos.dist, t);
      this.updatePoint(nodes.points[1], az.right, pos.el, pos.dist, t);
    }
  },

  // オブジェクトのパラメータ変更をライブのノードへ反映する。
  // 位置は setValueAtTime ではなく setTargetAtTime で滑らかに動かす（ドラッグ中のザラつき防止）。
  // width の変更はノード構成そのものが変わるので、グラフを組み直す。
  update(obj) {
    if (!obj) return;
    const n = this.live.get(obj.id);
    if (!n) return;
    const spreadNow = (obj.width || 0) !== 0;
    const spreadBefore = (n.width || 0) !== 0;
    if (spreadNow !== spreadBefore) {   // 点音源 <-> 2ソースの切り替わりはノード構成が変わる
      DAW.audio.resetNodes();
      DAW.audio.reschedule();
      return;
    }
    const ctx = DAW.audio.ctx;
    const t = ctx ? ctx.currentTime : 0;
    n.gain.gain.setTargetAtTime(DAW.objects.effectiveGain(obj), t, 0.01);
    // 経路が有効なら再生ヘッド位置の経路上の点、そうでなければ静的位置（posAt が判断する）
    this.applyObjPosition(n, obj, DAW.objects.posAt(obj, DAW.audio.getPos()), t);
    n.width = obj.width || 0;
  },

  // 経路のライブ追従。rAF（objui.tick）から毎フレーム呼ばれ、再生中でなければ何もしない。
  // setTargetAtTime(0.02s) の滑らかさで追うので、フレーム間の量子化は聴感上ならされる
  // （ループ折り返し時の 〜20ms のグライドも同じ仕組みによるもので仕様）。
  followPaths() {
    if (!DAW.audio.isPlaying()) return;
    const ctx = DAW.audio.ctx;
    if (!ctx) return;
    const pos = DAW.audio.getPos();
    const t = ctx.currentTime;
    for (const obj of DAW.objects.list) {
      if (!obj.path || !obj.path.enabled || !obj.path.points.length) continue;
      const n = this.live.get(obj.id);
      if (n) this.applyObjPosition(n, obj, DAW.objects.pathPosAt(obj, pos), t);
    }
  },

  // オブジェクトの現在のピーク（dBFS）。鳴っていない/ノード未生成なら -Infinity。
  // 呼ばれたときだけ計測するので、可視ストリップだけ更新すれば負荷は可視ぶんで収まる。
  peakDb(objId) {
    const n = this.live.get(objId);
    if (!n || !n.analyser) return -Infinity;
    n.analyser.getFloatTimeDomainData(n.meterBuf);
    let p = 0;
    for (let i = 0; i < n.meterBuf.length; i++) {
      const v = Math.abs(n.meterBuf[i]);
      if (v > p) p = v;
    }
    return p > 0 ? 20 * Math.log10(p) : -Infinity;
  },

  updateAll() {
    for (const obj of DAW.objects.list) this.update(obj);
  },

  // 出力形式の切り替え。ノードの作りが変わるので、音声グラフを組み直す。
  setMode(mode) {
    if (!this.setModeQuiet(mode)) return false;
    DAW.audio.reschedule();     // 再生中ならその位置から組み直す
    return true;
  },

  // グラフを捨てるだけで再スケジュールしない版。
  // play() の途中から呼ぶと reschedule が再入するので、そこではこちらを使う。
  setModeQuiet(mode) {
    const next = [this.MODE_HRTF, this.MODE_SPEAKERS, this.MODE_EQUALPOWER].includes(mode)
      ? mode : this.MODE_EQUALPOWER;
    if (next === this.mode) return false;
    this.mode = next;
    DAW.audio.resetNodes();     // live も一緒に消える
    return true;
  },

  // 自動切替の判定。試聴中（再生中かつ編集していない）なら HRTF、それ以外は等パワー。
  wantedMode(playing) {
    if (!this.autoHrtf) return this.mode;
    // スピーカー出力を選んでいるときは自動で切り替えない（出力形式はユーザーの選択なので）
    if (this.mode === this.MODE_SPEAKERS) return this.MODE_SPEAKERS;
    return playing && !this.editing ? this.MODE_HRTF : this.MODE_EQUALPOWER;
  },

  // 再生開始/停止のタイミングで呼ぶ（reschedule しない）
  applyAutoMode(playing) {
    if (!this.autoHrtf) return false;
    return this.setModeQuiet(this.wantedMode(playing));
  },

  // ビューでのドラッグ中は等パワーへ落とす（HRTF のまま動かすと重いため）
  beginEdit() {
    this.editing = true;
    if (this.mode === this.MODE_SPEAKERS) return;
    if (this.autoHrtf && this.setModeQuiet(this.MODE_EQUALPOWER)) DAW.audio.reschedule();
  },

  endEdit() {
    this.editing = false;
    // 再スケジュール中は playing が一瞬 false になるので、意図を返す isPlaying() を使う
    if (this.autoHrtf && this.setModeQuiet(this.wantedMode(DAW.audio.isPlaying()))) DAW.audio.reschedule();
  },

  // ライブのノードを切り離して捨てる。
  // Map を空にするだけだと、ノードはマスターに繋がったまま残って処理され続ける
  // （モード切替のたびに積み上がる）。必ず disconnect すること。
  reset() {
    for (const n of this.live.values()) {
      const kill = node => { if (node) { try { node.disconnect(); } catch (e) {} } };
      kill(n.input);
      kill(n.gain);
      kill(n.analyser);
      kill(n.rev);
      for (const p of n.points || []) {
        kill(p.src);
        kill(p.panner);
        kill(p.gl);
        kill(p.gr);
        for (const sg of p.spk || []) kill(sg);
        kill(p.output);
      }
    }
    this.live.clear();
    this.resetRevBus();   // 共有バスも切り離す（残すとマスターに繋がったまま積み上がる）
  },
};

// データモデル側の変更をライブの音へ伝える（UI から明示的に呼ばなくても追従させる）
DAW.objects.onChange = obj => DAW.objaudio.update(obj);
