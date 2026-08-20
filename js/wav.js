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

  // AudioBuffer の絶対値ピーク（1.0 超 = 16bit WAV 化でクリップする）
  peakOf(buffer) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > peak) peak = v;
      }
    }
    return peak;
  },

  toDbfs(peak) {
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  },

  // 先頭 skip サンプルを捨てた「AudioBuffer 互換の見た目」を返す。
  // リミッターの先読みぶん出力が遅れるので、書き出しではこれで波形を元の位置へ戻す。
  trimHead(buffer, skip) {
    if (!skip) return buffer;
    const len = Math.max(0, buffer.length - skip);
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c).subarray(skip, skip + len));
    return {
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      length: len,
      duration: len / buffer.sampleRate,
      getChannelData: c => chans[c],
    };
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

  // OfflineAudioContext で全トラックをレンダリングして WAV ダウンロード。
  // ループ区間が有効なら、その区間だけを書き出す（ボタンの表示もそれに合わせて変わる）。
  async exportMix() {
    const loop = DAW.activeLoop();
    const from = loop ? loop.start : 0;
    const to = loop ? loop.end : DAW.projectDuration();
    const dur = to - from;
    if (dur <= 0) {
      alert('書き出すクリップがありません');
      return;
    }
    DAW.audio.ensureCtx();
    const sr = DAW.audio.ctx.sampleRate; // ライブと同一レートでレンダリング
    // リミッターの先読みぶん出力が遅れるので、その分だけ長くレンダリングして後で頭を捨てる
    const latency = DAW.limiter.enabled ? DAW.limiter.latencySec() : 0;
    const skip = Math.round(latency * sr);
    // スピーカー出力（VBAP）のときは配置のチャンネル数で書き出す（5.1 なら 6ch）。
    // WAV エンコーダはチャンネル数をバッファから読むので、そのまま多チャンネルで出せる。
    const outCh = DAW.objaudio.outputChannels();
    const off = new OfflineAudioContext(outCh, Math.ceil(dur * sr) + skip, sr);
    const master = off.createGain();
    master.gain.value = DAW.project.masterVolume;
    master.connect(off.destination);
    await DAW.plugins.prepareAll(off, DAW.project.tracks);
    // 経路（位置オートメーション）の焼き込み範囲。オフライン ctx での objaudio.create()
    // （trackDest 経由）がこれを見てランプ列を予約する（trackDest のシグネチャは変えない）。
    // 例外で抜けてもライブ側に漏れないよう finally で必ず戻す。
    DAW.objaudio.exportRange = { from, until: to };
    try {
      for (const track of DAW.project.tracks) {
        const gain = off.createGain();
        gain.gain.value = DAW.effectiveGain(track);
        const panner = off.createStereoPanner();
        panner.pan.value = track.pan;
        DAW.audio.connectChain(off, track, gain, DAW.audio.trackDest(off, track, panner, master));
        for (const clip of track.clips) {
          DAW.audio.scheduleClip(off, gain, clip, from, 0, loop ? loop.end : undefined);
        }
      }
    } finally {
      DAW.objaudio.exportRange = null;
    }
    const raw = await off.startRendering();
    // リミッター前のピーク（どれだけ突っ込んでいるかの目安。警告の判定にも使う）
    const peak = this.peakOf(raw);
    this.lastExportPeak = peak;
    // リミッターはレンダリング後にメインスレッドで適用する（理由は js/limiter.js の冒頭）。
    // 先読みぶん遅れるので、頭を捨てて元の位置へ整列させる。
    const rendered = DAW.limiter.enabled
      ? this.trimHead(DAW.limiter.processBuffer(raw), skip)
      : raw;
    // 16bit WAV は ±1.0 で頭打ちになる。リミッターが有効ならシーリングで抑えられるので、
    // 警告を出すのはリミッターを切っているときだけ。
    if (!DAW.limiter.enabled && peak > 1.0) {
      const down = (1 / peak).toFixed(2);
      const proceed = confirm(
        `ミックスが 0dBFS を超えています（ピーク +${this.toDbfs(peak).toFixed(1)} dBFS）。\n` +
        `このまま書き出すと歪みます。マスター音量を ${down} 倍（現在の ${(DAW.project.masterVolume * +down).toFixed(2)}）程度まで下げてください。\n\n` +
        `OK: このまま書き出す / キャンセル: 中止`);
      if (!proceed) return;
    }
    this.download(new Blob([this.encodeWav16(rendered)], { type: 'audio/wav' }), loop ? 'loop.wav' : 'mix.wav');
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
      bpm: DAW.project.bpm,
      loop: { enabled: DAW.loop.enabled, start: DAW.loop.start, end: DAW.loop.end },
      objects: DAW.objects.toJSON(),
      // ルームリバーブのマスターパラメータ（RENDERER）。追加フィールドのみなので version:1 のまま互換
      roomReverb: Object.assign({}, DAW.objaudio.revParams),
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
        // 旧形式（enabled/wet フィールド欠落）は「有効・原音なし」の従来挙動に補完する。
        // 追加フィールドのみなので保存フォーマットは version:1 のまま互換。
        if (fx.enabled === undefined) fx.enabled = true;
        if (fx.wet === undefined) fx.wet = 1;
        return true;
      });
    }
    if (missing.size) alert(`未登録のプラグインをスキップしました: ${[...missing].join(', ')}`);
    DAW.buffers = buffers;
    DAW.peaks = peaks;
    DAW.project = {
      masterVolume: data.masterVolume != null ? data.masterVolume : 1,
      bpm: data.bpm != null ? data.bpm : 120,   // 旧バージョンのファイルは既定BPMで開く
      tracks: data.tracks,
    };
    DAW.objects.load(data.objects);   // 旧プロジェクトは objects を持たないので空になる
    DAW.objaudio.loadRevParams(data.roomReverb);   // 欠落は既定値（level=0 = 従来の音）で補完
    const loop = data.loop || {};
    DAW.loop.enabled = !!loop.enabled;
    DAW.loop.start = +loop.start || 0;
    DAW.loop.end = +loop.end || 0;
    DAW.audio.setMasterVolume(DAW.project.masterVolume);
    await DAW.plugins.prepareAll(ctx, DAW.project.tracks);
    return true;
  },
};
