'use strict';

// グローバル名前空間。全モジュールはここに attach する。
const DAW = {
  PPS: 100,          // 1秒あたりのピクセル数（固定。ズーム対応時は変数化する）
  PEAK_BUCKET: 512,  // 波形ピーク計算のバケットサイズ（サンプル数）

  buffers: new Map(), // bufferId -> AudioBuffer（クリップ間で共有）
  peaks: new Map(),   // bufferId -> Float32Array [min0, max0, min1, max1, ...]

  project: {
    masterVolume: 1,
    tracks: [],
  },

  TRACK_COLORS: ['#4f8cff', '#3fbf7f', '#e0a63f', '#d96a6a', '#9b6fd9', '#3fbfbf', '#d96ab8', '#8fbf3f'],

  uid() {
    return 'id' + Math.random().toString(36).slice(2, 10);
  },

  timeToPx(t) { return t * this.PPS; },
  pxToTime(px) { return px / this.PPS; },

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

  // どのクリップからも参照されなくなったバッファを解放する
  collectBuffers() {
    const used = new Set();
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
