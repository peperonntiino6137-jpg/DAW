'use strict';

// 再生エンジン。
// グラフ: Source(再生毎に生成) -> Track Gain -> [FXチェーン] -> StereoPanner -> masterGain -> destination
DAW.audio = {
  ctx: null,
  masterGain: null,
  trackNodes: new Map(), // trackId -> { gain, panner, fx: [instance] }

  playing: false,
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
    return this.ctx;
  },

  // gain -> fx... -> panner を接続し、FXインスタンス配列を返す。
  // ライブ/オフライン両方の ctx で使う（エクスポートからも呼ばれる）。
  connectChain(ctx, track, gain, panner) {
    let prev = gain;
    const instances = [];
    for (const fx of track.effects) {
      const def = DAW.plugins.get(fx.pluginId);
      if (!def) continue;
      const inst = def.create(ctx, fx.params);
      prev.connect(inst.input);
      prev = inst.output;
      instances.push(inst);
    }
    prev.connect(panner);
    return instances;
  },

  getTrackNodes(track) {
    let n = this.trackNodes.get(track.id);
    if (!n) {
      const gain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner();
      gain.gain.value = DAW.effectiveGain(track);
      panner.pan.value = track.pan;
      panner.connect(this.masterGain);
      const fx = this.connectChain(this.ctx, track, gain, panner);
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
    n.fx = this.connectChain(this.ctx, track, n.gain, n.panner);
  },

  setEffectParam(track, fxIndex, key, value) {
    const fx = track.effects[fxIndex];
    if (!fx) return;
    fx.params[key] = value;
    const n = this.trackNodes.get(track.id);
    if (n && n.fx[fxIndex]) n.fx[fxIndex].set(key, value);
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

  getPos() {
    if (!this.playing) return this.playheadPos;
    return Math.max(this.playStartPos, this.playStartPos + (this.ctx.currentTime - this.playStartCtxTime));
  },

  // 1クリップをスケジュールする。途中再生の offset 補正はここに集約。
  scheduleClip(ctx, dest, clip, fromPos, whenBase) {
    const buf = DAW.buffers.get(clip.bufferId);
    if (!buf) return null;
    const clipEnd = clip.startTime + clip.duration;
    if (clipEnd <= fromPos + 1e-6) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    if (clip.startTime >= fromPos) {
      src.start(whenBase + (clip.startTime - fromPos), clip.offset, clip.duration);
    } else {
      const skip = fromPos - clip.startTime;
      src.start(whenBase, clip.offset + skip, clip.duration - skip);
    }
    return src;
  },

  async play() {
    if (this.playing) return;
    const dur = DAW.projectDuration();
    if (dur <= 0) return;
    this.ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await DAW.plugins.prepareAll(this.ctx, DAW.project.tracks);
    if (this.playheadPos >= dur) this.playheadPos = 0;
    const whenBase = this.ctx.currentTime + 0.05;
    for (const track of DAW.project.tracks) {
      const nodes = this.getTrackNodes(track);
      for (const clip of track.clips) {
        const src = this.scheduleClip(this.ctx, nodes.gain, clip, this.playheadPos, whenBase);
        if (src) this.sources.push(src);
      }
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
    }
    this.sources = [];
  },

  pause() {
    if (!this.playing) return;
    const p = this.getPos();
    this.stopSources();
    this.playing = false;
    this.playheadPos = Math.min(p, DAW.projectDuration());
  },

  stop() {
    this.stopSources();
    this.playing = false;
    this.playheadPos = 0;
  },

  seek(t) {
    const wasPlaying = this.playing;
    if (this.playing) {
      this.stopSources();
      this.playing = false;
    }
    this.playheadPos = Math.max(0, t);
    if (wasPlaying) this.play();
  },

  // 再生中にクリップが編集されたら呼ぶ（全ソース停止 -> 同位置から再スケジュール）
  reschedule() {
    if (!this.playing) return;
    this.seek(this.getPos());
  },
};
