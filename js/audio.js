'use strict';

// 再生エンジン。
// グラフ: Source(再生毎に生成) -> Track Gain -> [FXチェーン] -> StereoPanner -> masterGain -> destination
DAW.audio = {
  ctx: null,
  masterGain: null,
  limiterNode: null,   // マスター後段のリミッター（AudioWorklet）
  trackNodes: new Map(), // trackId -> { gain, panner, fx: [instance] }

  metroGain: null,     // メトロノーム（クリック）専用の出力。マスター音量とは独立
  analysers: null,     // マスター出力のピーク計測用（L/R）
  meterBuf: null,

  playing: false,
  restarting: false,   // seek による再スケジュール中（playing が一瞬 false になる区間）
  playheadPos: 0,      // 停止中の再生ヘッド位置（秒）
  playStartPos: 0,     // 再生開始時のタイムライン位置
  playStartCtxTime: 0, // 再生開始時の ctx.currentTime
  sources: [],

  ensureCtx() {
    if (this.ctx) return this.ctx;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = DAW.project.masterVolume;
    this.masterGain.connect(this.ctx.destination);
    // レベルメーター用にマスター後段を L/R へ分岐して覗く（音の経路は変えない）
    const split = this.ctx.createChannelSplitter(2);
    this.masterGain.connect(split);
    this.analysers = [0, 1].map(ch => {
      const a = this.ctx.createAnalyser();
      a.fftSize = 1024;
      split.connect(a, ch);
      return a;
    });
    this.meterBuf = new Float32Array(this.analysers[0].fftSize);
    // クリックは「録音の目安」なのでマスター音量や書き出しの影響を受けない別経路にする
    this.metroGain = this.ctx.createGain();
    this.metroGain.gain.value = DAW.metronome.volume;
    this.metroGain.connect(this.ctx.destination);
    return this.ctx;
  },

  // 再生範囲のクリック音をまとめて予約する。
  // 小節頭だけ高い音にして、拍の頭が分かるようにしている。
  scheduleMetronome(fromPos, whenBase, until) {
    if (!DAW.metronome.enabled) return;
    const beat = DAW.beatDuration();
    if (!(beat > 0)) return;
    const ctx = this.ctx;
    this.metroGain.gain.value = DAW.metronome.volume;
    for (let i = Math.max(0, Math.ceil(fromPos / beat - 1e-9)); i * beat <= until; i++) {
      const t = whenBase + (i * beat - fromPos);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = i % 4 === 0 ? 1600 : 1000;   // 4/4 の1拍目だけ高く
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
      osc.connect(g);
      g.connect(this.metroGain);
      osc.start(t);
      osc.stop(t + 0.06);
      osc.fadeGain = g;
      this.sources.push(osc);   // 停止時にまとめて止める
    }
  },

  // マスター後段にリミッターを挿す。AudioWorklet の addModule が非同期なので、
  // 最初は masterGain -> destination で鳴らしておき、準備できたら差し替える。
  // メーターは masterGain から分岐したまま（= リミッター前）にしてあるので、
  // 「どれだけ突っ込んでいるか」が見える。表示の遅延補正も不要になる。
  async ensureLimiter() {
    this.ensureCtx();
    if (!DAW.limiter.enabled || this.limiterNode) return this.limiterNode;
    if (this.limiterFailed) return null;   // 準備に失敗した環境では素通し（再生は止めない）
    try {
      await DAW.limiter.prepare(this.ctx);
    } catch (e) {
      // Worklet が読めない環境でもリミッター無しで鳴らし続ける。失敗は一度だけ記録する。
      this.limiterFailed = true;
      console.warn('リミッターを初期化できないため素通しで再生します:', e);
      return null;
    }
    if (this.limiterNode) return this.limiterNode;   // 競合して二重に作らない
    const node = DAW.limiter.create(this.ctx);
    try { this.masterGain.disconnect(this.ctx.destination); } catch (e) {}
    this.masterGain.connect(node);
    node.connect(this.ctx.destination);
    this.limiterNode = node;
    DAW.limiter.node = node;
    return node;
  },

  // ラウドネス計測タップ（BS.1770-4）。METERING タブが開いたときだけ作る。
  // タップ位置は masterGain 直後 = **リミッター前**（ピークメーターと同じ規約。
  // どれだけ突っ込んでいるかが見えるほうが有用で、表示の遅延補正も要らない）。
  async ensureLoudness() {
    this.ensureCtx();
    return DAW.loudness.attach(this.ctx, this.masterGain);
  },

  // 画面表示用の再生位置。リミッターの先読みぶん出力が遅れるので、その分だけ戻す。
  displayPos() {
    return Math.max(0, this.getPos() - (this.isPlaying() ? DAW.limiter.latencySec() : 0));
  },

  // マスター出力の瞬時ピークを [L, R] で返す（1.0 超 = クリップ）。未再生なら 0。
  getLevels() {
    if (!this.analysers) return [0, 0];
    return this.analysers.map(a => {
      a.getFloatTimeDomainData(this.meterBuf);
      let p = 0;
      for (let i = 0; i < this.meterBuf.length; i++) {
        const v = Math.abs(this.meterBuf[i]);
        if (v > p) p = v;
      }
      return p;
    });
  },

  // gain -> [FXスロット]... -> panner を接続し、スロット配列を返す。
  // ライブ/オフライン両方の ctx で使う（エクスポートからも呼ばれる）。
  // 中身はラッパー層（js/wrapper.js）へ委譲。スロットは旧インスタンスと同じ
  // input/output/set を持つので、既存の呼び出し側・後始末コードはそのまま。
  connectChain(ctx, track, gain, panner) {
    return DAW.wrapper.buildChain(ctx, track, gain, panner);
  },

  // トラックの出力先を返す。オブジェクトに割り当てられていればオブジェクトパンナーの入口、
  // そうでなければ従来の StereoPanner。ライブ再生と書き出しの両方から呼ぶので、
  // オブジェクトの定位は「聞いた音」と「書き出した音」で必ず一致する。
  trackDest(ctx, track, panner, master) {
    const obj = DAW.objaudio.forTrack(track.id);
    if (!obj) {
      panner.connect(master);
      return panner;
    }
    const nodes = DAW.objaudio.create(ctx, obj, master);
    if (ctx === this.ctx) DAW.objaudio.remember(obj.id, nodes);   // ライブは後から更新できるように保持
    return nodes.input;
  },

  getTrackNodes(track) {
    let n = this.trackNodes.get(track.id);
    if (!n) {
      const gain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner();
      gain.gain.value = DAW.effectiveGain(track);
      panner.pan.value = track.pan;
      const fx = this.connectChain(this.ctx, track, gain, this.trackDest(this.ctx, track, panner, this.masterGain));
      n = { gain, panner, fx };
      this.trackNodes.set(track.id, n);
    }
    return n;
  },

  removeTrackNodes(trackId) {
    const n = this.trackNodes.get(trackId);
    if (!n) return;
    try { n.gain.disconnect(); } catch (e) {}
    for (const inst of n.fx) {
      try { inst.input.disconnect(); } catch (e) {}
      try { inst.output.disconnect(); } catch (e) {}
    }
    try { n.panner.disconnect(); } catch (e) {}
    this.trackNodes.delete(trackId);
  },

  resetNodes() {
    for (const id of [...this.trackNodes.keys()]) this.removeTrackNodes(id);
    DAW.objaudio.reset();
  },

  // FXの追加/削除後にトラックのチェーンを組み直す。
  // ソースは gain に接続されているので再スケジュール不要。
  rebuildTrackChain(track) {
    const n = this.trackNodes.get(track.id);
    if (!n) return;
    try { n.gain.disconnect(); } catch (e) {}
    for (const inst of n.fx) {
      try { inst.input.disconnect(); } catch (e) {}
      try { inst.output.disconnect(); } catch (e) {}
    }
    n.fx = this.connectChain(this.ctx, track, n.gain, this.trackDest(this.ctx, track, n.panner, this.masterGain));
  },

  setEffectParam(track, fxIndex, key, value) {
    const fx = track.effects[fxIndex];
    if (!fx) return;
    fx.params[key] = value;
    const n = this.trackNodes.get(track.id);
    if (n && n.fx[fxIndex]) n.fx[fxIndex].set(key, value);   // スロット経由でプラグインへ届く
  },

  // スロットの enable 切替。state（track.effects）とライブノードの両方へ反映する。
  // undo は呼び出し側（FXラック UI）が commit する（setEffectParam と同じ分担）。
  setEffectEnabled(track, fxIndex, on) {
    const fx = track.effects[fxIndex];
    if (!fx) return;
    fx.enabled = !!on;
    const n = this.trackNodes.get(track.id);
    if (n && n.fx[fxIndex] && n.fx[fxIndex].setEnabled) n.fx[fxIndex].setEnabled(fx.enabled);
  },

  // スロットの wet（MIX）変更。0..1 に丸めて state とライブノードへ反映する。
  setEffectWet(track, fxIndex, wet) {
    const fx = track.effects[fxIndex];
    if (!fx) return;
    fx.wet = Math.max(0, Math.min(1, +wet || 0));
    const n = this.trackNodes.get(track.id);
    if (n && n.fx[fxIndex] && n.fx[fxIndex].setWet) n.fx[fxIndex].setWet(fx.wet);
  },

  updateGains() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const track of DAW.project.tracks) {
      const n = this.trackNodes.get(track.id);
      if (!n) continue;
      n.gain.gain.setTargetAtTime(DAW.effectiveGain(track), t, 0.01);
      n.panner.pan.setTargetAtTime(track.pan, t, 0.01);
    }
  },

  setMasterVolume(v) {
    DAW.project.masterVolume = v;
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  },

  // 「トランスポートが走っている意図か」を返す。
  // seek() は一度 playing=false にしてから非同期に play() し直すため、その瞬間に
  // playing を見ると止まっているように見える。モード切替など、意図を知りたい側はこちらを使う。
  isPlaying() {
    return this.playing || this.restarting;
  },

  getPos() {
    if (!this.playing) return this.playheadPos;
    const t = Math.max(this.playStartPos, this.playStartPos + (this.ctx.currentTime - this.playStartCtxTime));
    const loop = DAW.activeLoop();
    if (loop && t >= loop.end) {
      const len = loop.end - loop.start;
      return loop.start + ((t - loop.start) % len);   // 区間内へ折り返す
    }
    return t;
  },

  // クリップ端の最小フェード（秒）。波形が途中で切れることで出る「プチッ」を防ぐ。
  // 5ms は聴感上ほぼ無音時間を作らず、かつ不連続を消せる長さ。
  DECLICK: 0.005,

  // クリップの実効フェード長。表示（UI）と音でクランプ規則がずれないよう、必ずここを通す。
  // withDeclick = true なら、クリック防止の最低長 DECLICK を含めた「実際に鳴る」長さを返す。
  // フェードイン/アウトが重ならないよう、それぞれクリップ長の半分で頭打ちにする。
  fadeLengths(clip, withDeclick) {
    const half = Math.max(0, clip.duration / 2);
    const raw = k => Math.max(clip[k] || 0, withDeclick ? this.DECLICK : 0);
    return { fi: Math.min(raw('fadeIn'), half), fo: Math.min(raw('fadeOut'), half) };
  },

  // クリップ内時刻 t（0..duration）でのフェード係数
  fadeGainAt(clip, t) {
    const dur = clip.duration;
    const { fi, fo } = this.fadeLengths(clip, true);
    let v = 1;
    if (t < fi) v = Math.min(v, t / fi);
    if (t > dur - fo) v = Math.min(v, (dur - t) / fo);
    return Math.max(0, Math.min(1, v));
  },

  // 1クリップをスケジュールする。途中再生の offset 補正とフェードはここに集約。
  // ライブ再生と書き出しの両方から呼ばれるので、聞こえ方は必ず一致する。
  // until: タイムライン上のこの位置で打ち切る（ループ再生用。既定は最後まで）。
  scheduleClip(ctx, dest, clip, fromPos, whenBase, until) {
    const buf = DAW.buffers.get(clip.bufferId);
    if (!buf) return null;
    const dur = clip.duration;
    const limit = until === undefined ? Infinity : until;
    const playFrom = Math.max(clip.startTime, fromPos);
    const playTo = Math.min(clip.startTime + dur, limit);
    if (playTo <= playFrom + 1e-6) return null;

    const skip = playFrom - clip.startTime;      // クリップ内で読み飛ばす長さ
    const playDur = playTo - playFrom;
    const t0 = whenBase + (playFrom - fromPos);
    const tEnd = t0 + playDur;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(dest);
    src.fadeGain = g;   // stopSources で切り離せるように持たせる

    const { fi, fo } = this.fadeLengths(clip, true);
    const env = t => this.fadeGainAt(clip, t);
    const inD = skip > 0 ? Math.min(this.DECLICK, playDur / 2) : 0;               // シーク時の立ち上げ
    const cut = playTo < clip.startTime + dur - 1e-9;                             // ループ等で途中打ち切り
    const outD = cut ? Math.min(this.DECLICK, playDur / 2) : 0;                   // 打ち切り時の落とし

    // エンベロープを (時刻, 値) の点列で組み立てる。
    // AudioParam の自動化イベントは時刻順に並べる必要があり、逆転するとゲインが暴れて段差が残る。
    const pts = [{ t: t0, v: inD > 0 ? 0 : env(skip) }];
    const add = (t, v) => {
      if (t <= pts[pts.length - 1].t + 1e-9) return;   // 時刻が進んでいない
      if (t >= tEnd - outD - 1e-9) return;             // 終端処理より後ろは無視
      pts.push({ t, v });
    };
    if (inD > 0) add(t0 + inD, env(skip + inD));
    add(t0 + (fi - skip), 1);                          // フェードイン終わり
    add(t0 + (dur - fo - skip), 1);                    // フェードアウト始まり
    if (outD > 0) pts.push({ t: tEnd - outD, v: env(skip + playDur - outD) });
    pts.push({ t: tEnd, v: 0 });

    g.gain.setValueAtTime(pts[0].v, pts[0].t);
    for (let i = 1; i < pts.length; i++) g.gain.linearRampToValueAtTime(pts[i].v, pts[i].t);

    src.start(t0, clip.offset + skip, playDur);
    return src;
  },

  // クリップが無くてもメトロノームが有効なら回す（録音時のクリック用）。
  // 予約はこの秒数だけ先まで行う。
  METRO_HORIZON: 300,

  // ループ再生で先まで予約しておく秒数
  LOOP_HORIZON: 60,

  async play() {
    if (this.playing) return;
    const dur = DAW.projectDuration();
    if (dur <= 0 && !DAW.metronome.enabled) return;
    if (DAW.activeLoop() && dur <= 0 && !DAW.metronome.enabled) return;
    this.ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // 試聴中は HRTF、編集中は等パワー（CPU 対策）。ノードを作る前に決める。
    DAW.objaudio.applyAutoMode(true);
    await this.ensureLimiter();
    await DAW.plugins.prepareAll(this.ctx, DAW.project.tracks);
    if (this.playheadPos >= dur) this.playheadPos = 0;
    const whenBase = this.ctx.currentTime + 0.05;
    const loop = DAW.activeLoop();
    if (loop) {
      // ループ再生。区間の繰り返しを先まで予約しておく（タイマーで折り返すと必ず継ぎ目が揺れる）。
      if (this.playheadPos < loop.start || this.playheadPos >= loop.end) this.playheadPos = loop.start;
      let when = whenBase;
      let from = this.playheadPos;
      const until = whenBase + this.LOOP_HORIZON;
      while (when < until) {
        for (const track of DAW.project.tracks) {
          const nodes = this.getTrackNodes(track);
          for (const clip of track.clips) {
            const src = this.scheduleClip(this.ctx, nodes.gain, clip, from, when, loop.end);
            if (src) this.sources.push(src);
          }
        }
        this.scheduleMetronome(from, when, loop.end);
        when += loop.end - from;
        from = loop.start;
      }
    } else {
      for (const track of DAW.project.tracks) {
        const nodes = this.getTrackNodes(track);
        for (const clip of track.clips) {
          const src = this.scheduleClip(this.ctx, nodes.gain, clip, this.playheadPos, whenBase);
          if (src) this.sources.push(src);
        }
      }
      this.scheduleMetronome(this.playheadPos, whenBase, Math.max(dur, this.playheadPos + this.METRO_HORIZON));
    }
    this.updateGains();
    this.playStartPos = this.playheadPos;
    this.playStartCtxTime = whenBase;
    this.playing = true;
  },

  stopSources() {
    for (const s of this.sources) {
      try { s.stop(); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
      if (s.fadeGain) { try { s.fadeGain.disconnect(); } catch (e) {} }
    }
    this.sources = [];
  },

  pause() {
    if (!this.playing) return;
    const p = this.getPos();
    this.stopSources();
    this.playing = false;
    this.playheadPos = Math.min(p, DAW.projectDuration());
    DAW.objaudio.applyAutoMode(false);   // 停止したら軽いモードへ戻す
  },

  stop() {
    this.stopSources();
    this.playing = false;
    this.playheadPos = 0;
    DAW.objaudio.applyAutoMode(false);
  },

  seek(t) {
    const wasPlaying = this.playing;
    if (this.playing) {
      this.stopSources();
      this.playing = false;
    }
    this.playheadPos = Math.max(0, t);
    if (wasPlaying) {
      this.restarting = true;
      Promise.resolve(this.play()).then(() => { this.restarting = false; }, () => { this.restarting = false; });
    }
  },

  // 再生中にクリップが編集されたら呼ぶ（全ソース停止 -> 同位置から再スケジュール）
  reschedule() {
    if (!this.playing) return;
    this.seek(this.getPos());
  },
};
