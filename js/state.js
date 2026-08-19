'use strict';

// グローバル名前空間。全モジュールはここに attach する。
const DAW = {
  PPS: 100,          // 1秒あたりのピクセル数（ズームで可変。DAW.setPPS で変更する）
  DEFAULT_PPS: 100,
  MIN_PPS: 4,        // 全体を俯瞰する側の限界（1画面に約5分）
  MAX_PPS: 1600,     // 波形を細かく編集する側の限界（1秒に1600px）
  PEAK_BUCKET: 512,  // 波形ピーク計算のバケットサイズ（サンプル数）

  buffers: new Map(), // bufferId -> AudioBuffer（クリップ間で共有）
  peaks: new Map(),   // bufferId -> Float32Array [min0, max0, min1, max1, ...]

  project: {
    masterVolume: 1,
    bpm: 120,
    tracks: [],
  },

  // ループ再生区間。start/end はタイムライン上の秒。
  // 表示・再生にだけ関わる設定なので Undo の対象にはしない（ズームと同じ扱い）。
  loop: {
    enabled: false,
    start: 0,
    end: 0,
  },

  // 有効なループ区間なら {start, end} を返す。短すぎる/未設定なら null。
  activeLoop() {
    const l = this.loop;
    return l.enabled && l.end - l.start > 0.05 ? l : null;
  },

  setLoop(start, end) {
    const a = Math.max(0, Math.min(start, end));
    const b = Math.max(start, end);
    this.loop.start = a;
    this.loop.end = b;
    return this.loop;
  },

  // メトロノーム（クリック）。BPM に従って再生・録音中に鳴らす。書き出しには入らない。
  metronome: {
    enabled: false,
    volume: 0.35,
  },

  // グリッド（拍の格子）。enabled のときだけ表示とスナップが効く。
  // division は「1マス何拍か」。4 = 1小節（4/4想定）、1 = 1拍、0.25 = 16分。
  grid: {
    enabled: false,
    division: 1,
  },

  TRACK_COLORS: ['#4f8cff', '#3fbf7f', '#e0a63f', '#d96a6a', '#9b6fd9', '#3fbfbf', '#d96ab8', '#8fbf3f'],

  uid() {
    return 'id' + Math.random().toString(36).slice(2, 10);
  },

  timeToPx(t) { return t * this.PPS; },
  pxToTime(px) { return px / this.PPS; },

  // ズーム倍率の設定。範囲外は丸める。実際に変化したかを返す。
  setPPS(pps) {
    const v = Math.max(this.MIN_PPS, Math.min(this.MAX_PPS, pps));
    if (v === this.PPS) return false;
    this.PPS = v;
    return true;
  },

  beatDuration() { return 60 / (this.project.bpm || 120); },
  barDuration() { return this.beatDuration() * 4; },
  gridStep() { return this.beatDuration() * this.grid.division; },

  // グリッドが有効なら最寄りのマスに吸着させる。bypass（Alt押下）で一時的に無効化。
  snapTime(t, bypass) {
    if (!this.grid.enabled || bypass) return t;
    const step = this.gridStep();
    return step > 0 ? Math.round(t / step) * step : t;
  },

  setBpm(bpm) {
    const v = Math.max(20, Math.min(300, bpm || 120));
    this.project.bpm = v;
    return v;
  },

  trackColor(index) {
    return this.TRACK_COLORS[index % this.TRACK_COLORS.length];
  },

  addTrack(name) {
    const track = {
      id: this.uid(),
      name: name || `トラック ${this.project.tracks.length + 1}`,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      effects: [], // { pluginId, params }
      clips: [],   // { id, bufferId, startTime, offset, duration, name }
    };
    this.project.tracks.push(track);
    return track;
  },

  removeTrack(trackId) {
    const i = this.project.tracks.findIndex(t => t.id === trackId);
    if (i < 0) return;
    DAW.audio.removeTrackNodes(trackId);
    this.project.tracks.splice(i, 1);
    this.collectBuffers();
  },

  // 選択中のクリップを時間方向にずらす（キーボードでの微調整用）。
  nudgeClip(clipId, delta) {
    const found = this.findClip(clipId);
    if (!found) return false;
    found.clip.startTime = Math.max(0, found.clip.startTime + delta);
    return true;
  },

  // クリップを上下のトラックへ移す
  moveClipToTrack(clipId, delta) {
    const found = this.findClip(clipId);
    if (!found) return false;
    const i = this.project.tracks.indexOf(found.track);
    const dest = this.project.tracks[i + delta];
    if (!dest) return false;
    found.track.clips.splice(found.track.clips.indexOf(found.clip), 1);
    dest.clips.push(found.clip);
    return true;
  },

  // キーボード操作の1歩ぶん（グリッドが有効ならそのマス、無効なら1秒）
  nudgeStep() {
    return this.grid.enabled ? this.gridStep() : 1;
  },

  // トラックの並び替え。delta は -1（上へ）か +1（下へ）。動かせなければ false。
  moveTrack(trackId, delta) {
    const i = this.project.tracks.findIndex(t => t.id === trackId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.project.tracks.length) return false;
    const [t] = this.project.tracks.splice(i, 1);
    this.project.tracks.splice(j, 0, t);
    return true;
  },

  findClip(clipId) {
    for (const track of this.project.tracks) {
      const clip = track.clips.find(c => c.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  },

  removeClip(clipId) {
    for (const track of this.project.tracks) {
      const i = track.clips.findIndex(c => c.id === clipId);
      if (i >= 0) {
        track.clips.splice(i, 1);
        this.collectBuffers();
        return;
      }
    }
  },

  clipboard: null,   // コピーしたクリップ（音声は複製せず bufferId を参照する）

  copyClip(clipId) {
    const found = this.findClip(clipId);
    if (!found) return null;
    const c = found.clip;
    this.clipboard = {
      bufferId: c.bufferId, offset: c.offset, duration: c.duration, name: c.name,
      fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
      trackId: found.track.id,   // 貼り付け先の既定
    };
    return this.clipboard;
  },

  // クリップボードの内容を time の位置へ貼る。trackId 省略時はコピー元のトラック（無ければ先頭）。
  pasteClip(time, trackId) {
    const c = this.clipboard;
    if (!c) return null;
    const track = this.project.tracks.find(t => t.id === (trackId || c.trackId)) || this.project.tracks[0];
    if (!track) return null;
    const clip = {
      id: this.uid(), bufferId: c.bufferId, startTime: Math.max(0, time),
      offset: c.offset, duration: c.duration, name: c.name, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
    };
    track.clips.push(clip);
    return clip;
  },

  // 選択中のクリップを直後に複製する（ループ素材を並べる用）
  duplicateClip(clipId) {
    const found = this.findClip(clipId);
    if (!found) return null;
    const c = found.clip;
    const copy = Object.assign({}, c, { id: this.uid(), startTime: c.startTime + c.duration });
    found.track.clips.splice(found.track.clips.indexOf(c) + 1, 0, copy);
    return copy;
  },

  // クリップ長が変わったら、フェードが長さの半分を超えないように詰める。
  // 音側（audio.fadeLengths）はクランプするので、これを怠ると表示と音がずれる。
  clampFades(clip) {
    const half = Math.max(0, clip.duration / 2);
    if (clip.fadeIn) clip.fadeIn = Math.min(clip.fadeIn, half);
    if (clip.fadeOut) clip.fadeOut = Math.min(clip.fadeOut, half);
    return clip;
  },

  // クリップをタイムライン上の時刻 t で2つに分割する。分割点が端に近すぎる場合は何もしない。
  // 分割面には自動でデクリック用の短いフェードがかかる（audio.scheduleClip 側の既定）。
  splitClip(clipId, t) {
    const found = this.findClip(clipId);
    if (!found) return null;
    const { track, clip } = found;
    const MIN = 0.02;
    if (t <= clip.startTime + MIN || t >= clip.startTime + clip.duration - MIN) return null;
    const left = t - clip.startTime;
    const right = {
      id: this.uid(),
      bufferId: clip.bufferId,
      startTime: t,
      offset: clip.offset + left,
      duration: clip.duration - left,
      name: clip.name,
      fadeIn: 0,                       // 分割面はデクリックのみ
      fadeOut: clip.fadeOut || 0,      // 元クリップの終端フェードは右側が引き継ぐ
    };
    clip.duration = left;
    clip.fadeOut = 0;
    this.clampFades(clip);
    this.clampFades(right);
    track.clips.splice(track.clips.indexOf(clip) + 1, 0, right);
    return right;
  },

  projectDuration() {
    let d = 0;
    for (const track of this.project.tracks)
      for (const clip of track.clips)
        d = Math.max(d, clip.startTime + clip.duration);
    return d;
  },

  anySolo() {
    return this.project.tracks.some(t => t.solo);
  },

  effectiveGain(track) {
    return (track.muted || (this.anySolo() && !track.solo)) ? 0 : track.volume;
  },

  // どのクリップからも参照されなくなったバッファを解放する。
  // Undo で復活しうるバッファ（履歴が参照しているもの）は残す。
  collectBuffers() {
    const used = this.history ? this.history.referencedBuffers() : new Set();
    if (this.clipboard) used.add(this.clipboard.bufferId);   // 貼り付け前に消えないように
    for (const track of this.project.tracks)
      for (const clip of track.clips)
        used.add(clip.bufferId);
    for (const id of [...this.buffers.keys()]) {
      if (!used.has(id)) {
        this.buffers.delete(id);
        this.peaks.delete(id);
      }
    }
  },

  registerBuffer(buffer) {
    const id = this.uid();
    this.buffers.set(id, buffer);
    this.peaks.set(id, this.computePeaks(buffer));
    return id;
  },

  computePeaks(buffer) {
    const B = this.PEAK_BUCKET;
    const n = Math.ceil(buffer.length / B);
    const peaks = new Float32Array(n * 2);
    for (let b = 0; b < n; b++) {
      peaks[b * 2] = Infinity;
      peaks[b * 2 + 1] = -Infinity;
    }
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const b = (i / B) | 0;
        const v = data[i];
        if (v < peaks[b * 2]) peaks[b * 2] = v;
        if (v > peaks[b * 2 + 1]) peaks[b * 2 + 1] = v;
      }
    }
    for (let b = 0; b < n; b++) {
      if (peaks[b * 2] === Infinity) { peaks[b * 2] = 0; peaks[b * 2 + 1] = 0; }
    }
    return peaks;
  },
};
