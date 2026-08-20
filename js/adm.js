'use strict';

// ADM (ITU-R BS.2076) 書き出しとオブジェクト別書き出し。
//
// 出力は BW64 (ITU-R BS.2088) コンテナ:
//   BW64 / ds64 / fmt / chna / axml / data
// の順にチャンクを並べる。BW64 と data のサイズフィールドは常に 0xFFFFFFFF（未定値）とし、
// 実サイズは ds64 チャンクに 64bit で持つ（4GB 未満でも RF64 流儀で統一。分岐を持たないため）。
//
// メタデータ (axml) は audioFormatExtended の最小構成:
//   audioProgramme -> audioContent -> audioObject -> audioPackFormat (type Objects)
//   -> audioChannelFormat (audioBlockFormat 列) と、PCM の完全チェーン
//   audioStreamFormat / audioTrackFormat / audioTrackUID（chna が参照する）。
//   BS.2076-2 の「audioTrackUID から audioChannelFormat 直接参照」の省略形は使わない
//   （外部ツールの互換性を最優先。判断の詳細は docs/DEVLOG.md）。
//
// 座標はデータモデル（js/objects.js）が既に ADM 準拠の極座標（az/el/dist）なので変換不要。
// distance は必ず出力する（0〜1 の絶対距離。省略しないのがこの DAW の差別化点）。
//
// 音声本体はオブジェクトごとに「割り当てトラックのクリップをモノラル素レンダリング」した
// 1 チャンネル（定位・リバーブ・トラック FX なし。トラックとオブジェクトの gain / ミュート /
// ソロは反映）。定位は再生側レンダラーがメタデータから行うため、焼き込まない。
DAW.adm = {
  BIT_DEPTH: 24,        // 音声本体のビット深度（放送系の実務標準。data チャンクは 24bit PCM）
  PROGRAMME_NAME: 'DAW Mix',

  // ---- ID 生成 ----
  // オブジェクト n 番目（1 始まり）の各要素 ID。type Objects = 0003、idx は 1001 から。
  ids(n) {
    const hex = (0x1000 + n).toString(16).toUpperCase();       // 1001, 1002, ...
    return {
      hex,
      content: `ACO_${hex}`,
      object: `AO_${hex}`,
      pack: `AP_0003${hex}`,
      channel: `AC_0003${hex}`,
      stream: `AS_0003${hex}`,
      track: `AT_0003${hex}_01`,
      uid: 'ATU_' + String(n).padStart(8, '0'),
    };
  },

  // ---- 時刻表記 ----
  // ADM の rtime / duration は "hh:mm:ss.fffff"（小数第5位まで）
  fmtTime(sec) {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = s % 60;
    const pad = (v, n) => String(v).padStart(n, '0');
    const whole = Math.floor(rest);
    const frac = Math.round((rest - whole) * 1e5);
    // 丸めで 1 秒へ繰り上がるケース（0.999999 など）を桁上げする
    if (frac >= 1e5) return this.fmtTime(h * 3600 + m * 60 + whole + 1);
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(whole, 2)}.${pad(frac, 5)}`;
  },

  escapeXml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  },

  // ---- 書き出し対象 ----
  // トラックが割り当てられているオブジェクトだけが音を持てる（未割り当ては出力しない）
  exportables() {
    return DAW.objects.list
      .map(obj => ({ obj, track: DAW.project.tracks.find(t => t.id === obj.trackId) || null }))
      .filter(e => e.track);
  },

  // 書き出し範囲。exportMix と同じ規則（ループ区間が有効ならその区間、なければ全体）
  range() {
    const loop = DAW.activeLoop();
    const from = loop ? loop.start : 0;
    const to = loop ? loop.end : DAW.projectDuration();
    return { from, to, loop: !!loop };
  },

  // ---- 経路 -> audioBlockFormat 列 ----
  //
  // 経路が無い（または無効）なら静的位置のブロック 1 個。
  // 経路があれば bakeTimes（20ms 刻み + waypoint 時刻。書き出しの焼き込みと同じ）で
  // サンプリングし、隣接時刻の区間をブロックにする。ADM の補間規則
  // 「ブロック値は前ブロック値から duration かけて線形補間され、終端で到達する」に合わせて
  // 各ブロックの位置は「区間終端の位置」。先頭ブロックだけは前ブロックが無く値が
  // そのまま保持されるので「初期位置」を持つ（誤差は最大 20ms ぶんの移動量）。
  bakeBlocks(obj, from, until) {
    const path = obj.path;
    if (!(path && path.enabled && path.points.length)) {
      const dur = until - from;
      return [{ rtime: 0, duration: dur, az: obj.az, el: obj.el, dist: obj.dist }];
    }
    const times = DAW.objaudio.bakeTimes(path.points, from, until, path.loop);   // loop は周回ぶん展開される
    const blocks = [];
    for (let i = 0; i + 1 < times.length; i++) {
      const pos = DAW.objects.pathPosAt(obj, i === 0 ? times[0] : times[i + 1]);
      blocks.push({
        rtime: times[i] - from,
        duration: times[i + 1] - times[i],
        az: pos.az, el: pos.el, dist: pos.dist,
      });
    }
    return blocks;
  },

  // ---- axml（ADM メタデータ XML）----
  buildAxml(entries, from, until, sr) {
    const esc = s => this.escapeXml(s);
    const dur = this.fmtTime(until - from);
    const zero = this.fmtTime(0);
    const L = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2016" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xml:lang="en">');
    L.push('  <coreMetadata><format><audioFormatExtended version="ITU-R_BS.2076-2">');

    // programme（全体で 1 個）と、その下の content 一覧
    L.push(`    <audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="${esc(this.PROGRAMME_NAME)}" start="${zero}" end="${dur}">`);
    entries.forEach((e, i) => {
      L.push(`      <audioContentIDRef>${this.ids(i + 1).content}</audioContentIDRef>`);
    });
    L.push('    </audioProgramme>');

    entries.forEach((e, i) => {
      const id = this.ids(i + 1);
      const name = esc(e.obj.name);
      L.push(`    <audioContent audioContentID="${id.content}" audioContentName="${name}">`);
      L.push(`      <audioObjectIDRef>${id.object}</audioObjectIDRef>`);
      L.push('    </audioContent>');
      L.push(`    <audioObject audioObjectID="${id.object}" audioObjectName="${name}" start="${zero}" duration="${dur}">`);
      L.push(`      <audioPackFormatIDRef>${id.pack}</audioPackFormatIDRef>`);
      L.push(`      <audioTrackUIDRef>${id.uid}</audioTrackUIDRef>`);
      L.push('    </audioObject>');
      L.push(`    <audioPackFormat audioPackFormatID="${id.pack}" audioPackFormatName="${name}" typeLabel="0003" typeDefinition="Objects">`);
      L.push(`      <audioChannelFormatIDRef>${id.channel}</audioChannelFormatIDRef>`);
      L.push('    </audioPackFormat>');
      L.push(`    <audioChannelFormat audioChannelFormatID="${id.channel}" audioChannelFormatName="${name}" typeLabel="0003" typeDefinition="Objects">`);
      const blocks = this.bakeBlocks(e.obj, from, until);
      blocks.forEach((b, k) => {
        const bid = `AB_0003${id.hex}_${String(k + 1).padStart(8, '0')}`;
        L.push(`      <audioBlockFormat audioBlockFormatID="${bid}" rtime="${this.fmtTime(b.rtime)}" duration="${this.fmtTime(b.duration)}">`);
        L.push(`        <position coordinate="azimuth">${b.az.toFixed(4)}</position>`);
        L.push(`        <position coordinate="elevation">${b.el.toFixed(4)}</position>`);
        L.push(`        <position coordinate="distance">${b.dist.toFixed(4)}</position>`);
        L.push('        <cartesian>0</cartesian>');
        L.push('      </audioBlockFormat>');
      });
      L.push('    </audioChannelFormat>');
      // PCM の完全チェーン（chna の trackRef が指す audioTrackFormat まで揃える）
      L.push(`    <audioStreamFormat audioStreamFormatID="${id.stream}" audioStreamFormatName="PCM_${name}" formatLabel="0001" formatDefinition="PCM">`);
      L.push(`      <audioChannelFormatIDRef>${id.channel}</audioChannelFormatIDRef>`);
      L.push(`      <audioTrackFormatIDRef>${id.track}</audioTrackFormatIDRef>`);
      L.push('    </audioStreamFormat>');
      L.push(`    <audioTrackFormat audioTrackFormatID="${id.track}" audioTrackFormatName="PCM_${name}" formatLabel="0001" formatDefinition="PCM">`);
      L.push(`      <audioStreamFormatIDRef>${id.stream}</audioStreamFormatIDRef>`);
      L.push('    </audioTrackFormat>');
      L.push(`    <audioTrackUID UID="${id.uid}" sampleRate="${sr}" bitDepth="${this.BIT_DEPTH}">`);
      L.push(`      <audioTrackFormatIDRef>${id.track}</audioTrackFormatIDRef>`);
      L.push(`      <audioPackFormatIDRef>${id.pack}</audioPackFormatIDRef>`);
      L.push('    </audioTrackUID>');
    });
    L.push('  </audioFormatExtended></format></coreMetadata>');
    L.push('</ebuCoreMain>');
    return L.join('\n');
  },

  // ---- モノラル素レンダリング ----
  //
  // 割り当てトラックのクリップを 1ch でレンダリングする。定位（パン / オブジェクトパンナー）・
  // ルームリバーブ・トラック FX は通さない（メタデータで再現される「素」の音）。
  // トラックの gain / mute / solo とオブジェクトの gainDb / mute / solo は反映する
  // （鳴らない状態のオブジェクトは無音チャンネルになる）。
  async renderObjectMono(obj, track, from, until, sr) {
    const len = Math.max(1, Math.ceil((until - from) * sr));
    const off = new OfflineAudioContext(1, len, sr);
    const gain = off.createGain();
    gain.gain.value = DAW.effectiveGain(track) * DAW.objects.effectiveGain(obj);
    gain.connect(off.destination);
    for (const clip of track.clips) {
      DAW.audio.scheduleClip(off, gain, clip, from, 0, until);
    }
    return off.startRendering();
  },

  // 全書き出し対象のモノラルバッファを（直列で）レンダリングして返す
  async renderAll(entries, from, until, sr) {
    const buffers = [];
    for (const e of entries) buffers.push(await this.renderObjectMono(e.obj, e.track, from, until, sr));
    return buffers;
  },

  // ---- chna チャンク（BS.2088）----
  // 1 エントリ 40 バイト: trackIndex(u16) + UID(12) + trackRef(14) + packRef(11) + pad(1)
  buildChna(count) {
    const size = 4 + 40 * count;
    const ab = new ArrayBuffer(8 + size);
    const dv = new DataView(ab);
    const ws = (o, s, n) => {
      for (let i = 0; i < n; i++) dv.setUint8(o + i, i < s.length ? s.charCodeAt(i) : 0);
    };
    ws(0, 'chna', 4);
    dv.setUint32(4, size, true);
    dv.setUint16(8, count, true);    // numTracks
    dv.setUint16(10, count, true);   // numUIDs（1 トラック = 1 UID）
    for (let n = 1; n <= count; n++) {
      const id = this.ids(n);
      const o = 12 + 40 * (n - 1);
      dv.setUint16(o, n, true);      // trackIndex は 1 始まり
      ws(o + 2, id.uid, 12);
      ws(o + 14, id.track, 14);
      ws(o + 28, id.pack, 11);
      dv.setUint8(o + 39, 0);
    }
    return ab;
  },

  // ---- BW64 コンテナの組み立て ----
  // buffers は同一長・同一レートのモノラル AudioBuffer 群（1 本 = 1 チャンネル）。
  encodeBw64(buffers, axmlStr, chnaBuf, sr) {
    const numCh = buffers.length;
    const len = buffers[0].length;
    const bytes = this.BIT_DEPTH / 8;
    const blockAlign = numCh * bytes;
    const dataSize = len * blockAlign;
    const axmlBytes = new TextEncoder().encode(axmlStr);
    const axmlPad = axmlBytes.length % 2;                    // チャンクは 2 バイト境界に揃える
    const ds64Size = 28;                                     // bw64Size + dataSize + dummy + tableLength
    const total = 12 + (8 + ds64Size) + (8 + 16) + chnaBuf.byteLength
      + (8 + axmlBytes.length + axmlPad) + (8 + dataSize);
    const ab = new ArrayBuffer(total);
    const dv = new DataView(ab);
    const u8 = new Uint8Array(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    const u64 = (o, v) => {   // 64bit LE（JS の安全整数内なので上位は /2^32 で足りる）
      dv.setUint32(o, v >>> 0, true);
      dv.setUint32(o + 4, Math.floor(v / 0x100000000), true);
    };
    let o = 0;
    // BW64 ヘッダ。サイズは常に -1 とし、実サイズは ds64 が持つ
    ws(0, 'BW64'); dv.setUint32(4, 0xFFFFFFFF, true); ws(8, 'WAVE');
    o = 12;
    ws(o, 'ds64'); dv.setUint32(o + 4, ds64Size, true);
    u64(o + 8, total - 8);        // bw64Size（BW64 チャンクのサイズフィールド相当）
    u64(o + 16, dataSize);        // data チャンクの実サイズ
    u64(o + 24, len);             // dummy（sampleCount 相当）
    dv.setUint32(o + 32, 0, true);   // チャンクサイズテーブルは持たない
    o += 8 + ds64Size;
    // fmt: 24bit PCM
    ws(o, 'fmt '); dv.setUint32(o + 4, 16, true);
    dv.setUint16(o + 8, 1, true);
    dv.setUint16(o + 10, numCh, true);
    dv.setUint32(o + 12, sr, true);
    dv.setUint32(o + 16, sr * blockAlign, true);
    dv.setUint16(o + 20, blockAlign, true);
    dv.setUint16(o + 22, this.BIT_DEPTH, true);
    o += 8 + 16;
    u8.set(new Uint8Array(chnaBuf), o);
    o += chnaBuf.byteLength;
    ws(o, 'axml'); dv.setUint32(o + 4, axmlBytes.length + axmlPad, true);
    u8.set(axmlBytes, o + 8);
    o += 8 + axmlBytes.length + axmlPad;
    // data。サイズフィールドは -1（実サイズは ds64）。サンプル書き込みは wav.js と共用
    ws(o, 'data'); dv.setUint32(o + 4, 0xFFFFFFFF, true);
    DAW.wav.writeSamples(dv, o + 8, {
      numberOfChannels: numCh,
      length: len,
      getChannelData: c => buffers[c].getChannelData(0),
    }, this.BIT_DEPTH);
    return ab;
  },

  // ---- 入口: ADM (BW64) 書き出し ----
  async exportAdm() {
    const entries = this.exportables();
    const { from, to, loop } = this.range();
    if (!entries.length) {
      alert('書き出せるオブジェクトがありません（トラックを割り当ててください）');
      return;
    }
    if (to - from <= 0) {
      alert('書き出すクリップがありません');
      return;
    }
    DAW.audio.ensureCtx();
    const sr = DAW.wav.exportOptions.sampleRate || DAW.audio.ctx.sampleRate;
    const buffers = await this.renderAll(entries, from, to, sr);
    const axml = this.buildAxml(entries, from, to, sr);
    const chna = this.buildChna(entries.length);
    const ab = this.encodeBw64(buffers, axml, chna, sr);
    DAW.wav.download(new Blob([ab], { type: 'audio/wav' }), loop ? 'loop.adm.wav' : 'mix.adm.wav');
  },

  // ---- 入口: オブジェクト別 WAV 書き出し ----
  // 同じ素レンダリングを 1 本ずつモノラル WAV で個別ダウンロードする。
  // ビット深度は書き出しオプション（DAW.wav.exportOptions.bitDepth）に従う。
  async exportObjects() {
    const entries = this.exportables();
    const { from, to } = this.range();
    if (!entries.length) {
      alert('書き出せるオブジェクトがありません（トラックを割り当ててください）');
      return;
    }
    if (to - from <= 0) {
      alert('書き出すクリップがありません');
      return;
    }
    DAW.audio.ensureCtx();
    const sr = DAW.wav.exportOptions.sampleRate || DAW.audio.ctx.sampleRate;
    const bitDepth = DAW.wav.exportOptions.bitDepth;
    for (let i = 0; i < entries.length; i++) {
      const buf = await this.renderObjectMono(entries[i].obj, entries[i].track, from, to, sr);
      const safe = String(entries[i].obj.name).replace(/[\\/:*?"<>|]/g, '_');
      DAW.wav.download(
        new Blob([DAW.wav.encodeWav(buf, { bitDepth })], { type: 'audio/wav' }),
        `${String(i + 1).padStart(2, '0')}_${safe}.wav`);
    }
  },
};
