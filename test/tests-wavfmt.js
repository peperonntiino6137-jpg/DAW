'use strict';
// =====================================================================
// WAV 書き出しの一般化（encodeWav: 16/24/32bit float + サンプルレート指定）のテスト。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function wavFmtSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.project.masterVolume = 1;
    DAW.objects.clear();
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.metronome.enabled = false;
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    H.downloads.length = 0;
    H.alerts.length = 0;
    H.confirms.length = 0;   // 前のスイートが残したモーダルを拾わない
    H.confirmResult = true;
    const limWas = DAW.limiter.enabled;
    try { await body(okf); } finally {
      DAW.wav.exportOptions.bitDepth = 16;
      DAW.wav.exportOptions.sampleRate = 0;
      DAW.limiter.setEnabled(limWas);
      H.confirmResult = true;
      DAW.audio.resetNodes();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

wavFmtSuite('[43] WAV書き出しの一般化', async (okf) => {
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;

  // ---- チャンク走査（fmt/fact/data 以外が挟まっても壊れない読み方）----
  const tag4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const chunks = ab => {
    const dv = new DataView(ab);
    const out = { riff: tag4(dv, 0), riffSize: dv.getUint32(4, true), wave: tag4(dv, 8) };
    let pos = 12;
    while (pos + 8 <= dv.byteLength) {
      const id = tag4(dv, pos), size = dv.getUint32(pos + 4, true);
      out[id.trim()] = { offset: pos + 8, size };
      pos += 8 + size + (size & 1);
    }
    return out;
  };
  const fmtOf = ab => {
    const dv = new DataView(ab);
    const c = chunks(ab);
    const o = c.fmt.offset;
    return {
      size: c.fmt.size,
      tag: dv.getUint16(o, true),
      ch: dv.getUint16(o + 2, true),
      sr: dv.getUint32(o + 4, true),
      byteRate: dv.getUint32(o + 8, true),
      blockAlign: dv.getUint16(o + 12, true),
      bits: dv.getUint16(o + 14, true),
    };
  };
  // 24bit LE 符号付きの読み出し
  const readI24 = (dv, o) => {
    let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    return v >= 0x800000 ? v - 0x1000000 : v;
  };
  // 既知サンプル列の擬似バッファ（encodeWav は AudioBuffer 互換の形を受ける）
  const vals = [0, 0.5, -0.5, 1, -1, 1.5, -1.5];
  const fake = { numberOfChannels: 1, sampleRate: 48000, length: vals.length, getChannelData: () => Float32Array.from(vals) };

  // ---- 16bit（従来互換）----
  {
    const ab = DAW.wav.encodeWav(fake, { bitDepth: 16 });
    const old = DAW.wav.encodeWav16(fake);
    const a = new Uint8Array(ab), b = new Uint8Array(old);
    okf('F.1 encodeWav16 と encodeWav(16) はバイト一致',
      a.length === b.length && a.every((v, i) => v === b[i]), `${a.length} バイト`);
    const f = fmtOf(ab);
    okf('F.2 16bit の fmt（tag=1 / bits=16 / blockAlign / byteRate）',
      f.tag === 1 && f.bits === 16 && f.size === 16 && f.blockAlign === 2 && f.byteRate === 48000 * 2,
      JSON.stringify(f));
    const c = chunks(ab);
    okf('F.3 RIFF サイズと data サイズが整合',
      c.riff === 'RIFF' && c.wave === 'WAVE' && c.riffSize === ab.byteLength - 8 && c.data.size === vals.length * 2,
      `riff=${c.riffSize} data=${c.data.size}`);
    const dv = new DataView(ab);
    const s = i => dv.getInt16(c.data.offset + i * 2, true);
    okf('F.4 16bit の量子化値（0 / ±0.5 / ±1 / クランプ）',
      s(0) === 0 && s(1) === 16383 && s(2) === -16384 && s(3) === 32767 && s(4) === -32768
      && s(5) === 32767 && s(6) === -32768,
      `[${vals.map((_, i) => s(i)).join(', ')}]`);
  }

  // ---- 24bit ----
  {
    const ab = DAW.wav.encodeWav(fake, { bitDepth: 24 });
    const f = fmtOf(ab);
    okf('F.5 24bit の fmt（tag=1 / bits=24 / blockAlign=3 / byteRate）',
      f.tag === 1 && f.bits === 24 && f.size === 16 && f.blockAlign === 3 && f.byteRate === 48000 * 3,
      JSON.stringify(f));
    const c = chunks(ab);
    okf('F.6 24bit の data サイズ（3 バイト/サンプル）',
      c.data.size === vals.length * 3 && c.riffSize === ab.byteLength - 8, `data=${c.data.size}`);
    const dv = new DataView(ab);
    const s = i => readI24(dv, c.data.offset + i * 3);
    okf('F.7 24bit の量子化値（0 / ±0.5 / ±1 / クランプ）',
      s(0) === 0 && s(1) === 4194303 && s(2) === -4194304 && s(3) === 8388607 && s(4) === -8388608
      && s(5) === 8388607 && s(6) === -8388608,
      `[${vals.map((_, i) => s(i)).join(', ')}]`);
  }

  // ---- 32bit float ----
  {
    const ab = DAW.wav.encodeWav(fake, { bitDepth: '32f' });
    const f = fmtOf(ab);
    okf('F.8 32f の fmt（tag=3 / bits=32 / cbSize 付きで size=18）',
      f.tag === 3 && f.bits === 32 && f.size === 18 && f.blockAlign === 4 && f.byteRate === 48000 * 4,
      JSON.stringify(f));
    const c = chunks(ab);
    okf('F.9 32f は fact チャンクを持つ（dwSampleLength = フレーム数）',
      c.fact && c.fact.size === 4 && new DataView(ab).getUint32(c.fact.offset, true) === vals.length,
      c.fact ? `len=${new DataView(ab).getUint32(c.fact.offset, true)}` : 'fact 無し');
    const dv = new DataView(ab);
    const s = i => dv.getFloat32(c.data.offset + i * 4, true);
    okf('F.10 32f はサンプル値をそのまま保存（±1.0 超もクランプしない）',
      s(0) === 0 && s(1) === 0.5 && s(2) === -0.5 && s(3) === 1 && s(5) === 1.5 && s(6) === -1.5,
      `[${vals.map((_, i) => s(i)).join(', ')}]`);
  }

  // ---- exportMix 経路（ビット深度・サンプルレートの選択）----
  // 一定振幅 0.25 のモノラル素材。StereoPanner(pan=0) で各チャンネル ×1/√2 になる
  const PAN0 = Math.SQRT1_2;
  const AMP = 0.25;
  {
    const buf = ctx0.createBuffer(1, Math.round(SRT * 0.5), SRT);
    buf.getChannelData(0).fill(AMP);
    const bid = DAW.registerBuffer(buf);
    DAW.project.tracks[0].clips.push({
      id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 0.5, name: 'dc', fadeIn: 0, fadeOut: 0,
    });
  }
  DAW.limiter.setEnabled(false);   // 値の検証なのでリミッターは通さない
  const lastAb = async () => await H.downloads[H.downloads.length - 1].blob.arrayBuffer();

  {
    DAW.wav.exportOptions.bitDepth = 24;
    DAW.wav.exportOptions.sampleRate = 0;
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await lastAb();
    const f = fmtOf(ab);
    const c = chunks(ab);
    const dv = new DataView(ab);
    // 0.25 秒地点（中央）の L サンプル
    const mid = readI24(dv, c.data.offset + Math.round(0.25 * f.sr) * f.blockAlign);
    const expect = (AMP * PAN0 * 8388607) | 0;
    okf('F.11 exportMix: 24bit を選ぶと 24bit で書き出される',
      f.tag === 1 && f.bits === 24 && f.ch === 2 && f.sr === SRT, JSON.stringify(f));
    okf('F.12 exportMix: 24bit のサンプル値が正しい', Math.abs(mid - expect) <= 1,
      `実測=${mid} 期待=${expect}±1`);
  }

  {
    DAW.wav.exportOptions.bitDepth = '32f';
    DAW.wav.exportOptions.sampleRate = 48000;
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await lastAb();
    const f = fmtOf(ab);
    const c = chunks(ab);
    const frames = c.data.size / f.blockAlign;
    const mid = new DataView(ab).getFloat32(c.data.offset + Math.round(0.25 * 48000) * f.blockAlign, true);
    okf('F.13 exportMix: レート 48kHz 指定がヘッダに反映される',
      f.tag === 3 && f.bits === 32 && f.sr === 48000, JSON.stringify(f));
    okf('F.14 exportMix: 48kHz でフレーム数が 0.5 秒ぶんになる',
      Math.abs(frames - 24000) <= 48, `frames=${frames}`);
    okf('F.15 exportMix: 32f のサンプル値が正しい', Math.abs(mid - AMP * PAN0) < 1e-3,
      `実測=${mid.toFixed(5)} 期待=${(AMP * PAN0).toFixed(5)}`);
  }

  // ---- 0dBFS 超の扱い ----
  // マスターを上げてピークを 1.0 超にする。32f は警告なしでそのまま保存、16bit は確認が出る
  DAW.project.masterVolume = 6;   // 0.25×1/√2×6 ≈ 1.06
  {
    DAW.wav.exportOptions.bitDepth = '32f';
    DAW.wav.exportOptions.sampleRate = 0;
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const confirms = takeConfirms();
    const ab = await lastAb();
    const f = fmtOf(ab);
    const c = chunks(ab);
    const mid = new DataView(ab).getFloat32(c.data.offset + Math.round(0.25 * f.sr) * f.blockAlign, true);
    okf('F.16 32f では 0dBFS 超でも確認を出さない', confirms.length === 0, `confirm ${confirms.length} 件`);
    okf('F.17 32f は 1.0 超のサンプルをそのまま保存する', mid > 1.0,
      `実測=${mid.toFixed(4)}（期待 ≈1.06）`);
  }
  {
    DAW.wav.exportOptions.bitDepth = 16;
    H.confirmResult = false;   // 確認をキャンセルする
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const confirms = takeConfirms();
    okf('F.18 16bit では 0dBFS 超で確認が出て、キャンセルなら書き出さない',
      confirms.length === 1 && H.downloads.length === 0,
      `confirm ${confirms.length} 件 / downloads ${H.downloads.length}`);
    H.confirmResult = true;
  }
  DAW.project.masterVolume = 1;

  okf('F.19 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
