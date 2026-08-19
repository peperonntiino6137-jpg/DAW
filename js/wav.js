'use strict';

// WAVエンコード、ミックス書き出し、プロジェクト保存/読み込み
DAW.wav = {
  // AudioBuffer -> 16bit PCM WAV の ArrayBuffer
  encodeWav16(buffer) {
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const blockAlign = numCh * 2;
    const dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE');
    ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        dv.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
        o += 2;
      }
    }
    return ab;
  },

  arrayBufferToBase64(ab) {
    const bytes = new Uint8Array(ab);
    const CHUNK = 0x8000;
    let s = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  },

  base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  },

  download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  },

  // OfflineAudioContext で全トラックをレンダリングして WAV ダウンロード
  async exportMix() {
    const dur = DAW.projectDuration();
    if (dur <= 0) {
      alert('書き出すクリップがありません');
      return;
    }
    DAW.audio.ensureCtx();
    const sr = DAW.audio.ctx.sampleRate; // ライブと同一レートでレンダリング
    const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const master = off.createGain();
    master.gain.value = DAW.project.masterVolume;
    master.connect(off.destination);
    await DAW.plugins.prepareAll(off, DAW.project.tracks);
    for (const track of DAW.project.tracks) {
      const gain = off.createGain();
      gain.gain.value = DAW.effectiveGain(track);
      const panner = off.createStereoPanner();
      panner.pan.value = track.pan;
      DAW.audio.connectChain(off, track, gain, panner);
      panner.connect(master);
      for (const clip of track.clips) {
        DAW.audio.scheduleClip(off, gain, clip, 0, 0);
      }
    }
    const rendered = await off.startRendering();
    this.download(new Blob([this.encodeWav16(rendered)], { type: 'audio/wav' }), 'mix.wav');
  },

  // プロジェクトを JSON（音声は WAV -> base64 埋め込み）で保存。
  // 注意: base64 で約33%サイズが増え、音声は16bitに再エンコードされる。
  // 長尺（10分超相当）のプロジェクトはファイルが巨大になるため非推奨。
  saveProject() {
    const used = new Set();
    for (const track of DAW.project.tracks)
      for (const clip of track.clips)
        used.add(clip.bufferId);
    const buffers = {};
    for (const id of used) {
      const buf = DAW.buffers.get(id);
      if (buf) buffers[id] = { wav: this.arrayBufferToBase64(this.encodeWav16(buf)) };
    }
    const data = {
      version: 1,
      masterVolume: DAW.project.masterVolume,
      tracks: DAW.project.tracks,
      buffers,
    };
    this.download(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'project.daw.json');
  },

  async loadProject(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      alert('プロジェクトファイルを読み込めませんでした');
      return false;
    }
    if (!data || data.version !== 1 || !Array.isArray(data.tracks)) {
      alert('プロジェクトファイルの形式が不正です');
      return false;
    }
    DAW.audio.stop();
    DAW.audio.resetNodes();
    const ctx = DAW.audio.ensureCtx();
    const buffers = new Map();
    const peaks = new Map();
    for (const [id, entry] of Object.entries(data.buffers || {})) {
      const buf = await ctx.decodeAudioData(this.base64ToArrayBuffer(entry.wav));
      buffers.set(id, buf);
      peaks.set(id, DAW.computePeaks(buf));
    }
    // 未登録プラグインのエフェクトは警告して除外
    const missing = new Set();
    for (const track of data.tracks) {
      track.effects = (track.effects || []).filter(fx => {
        const def = DAW.plugins.get(fx.pluginId);
        if (!def) { missing.add(fx.pluginId); return false; }
        fx.params = Object.assign(DAW.plugins.defaultParams(def), fx.params);
        return true;
      });
    }
    if (missing.size) alert(`未登録のプラグインをスキップしました: ${[...missing].join(', ')}`);
    DAW.buffers = buffers;
    DAW.peaks = peaks;
    DAW.project = { masterVolume: data.masterVolume != null ? data.masterVolume : 1, tracks: data.tracks };
    DAW.audio.setMasterVolume(DAW.project.masterVolume);
    await DAW.plugins.prepareAll(ctx, DAW.project.tracks);
    return true;
  },
};
