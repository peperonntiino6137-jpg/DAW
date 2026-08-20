'use strict';
// =====================================================================
// ADM (ITU-R BS.2076) 書き出しとオブジェクト別書き出し（js/adm.js）のテスト。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function admSuite(group, body) {
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
    DAW.ui.renderTracks();
    DAW.history.reset();
    H.downloads.length = 0;
    H.alerts.length = 0;
    H.confirms.length = 0;   // 前のスイートが残したモーダルを拾わない
    H.confirmResult = true;
    try { await body(okf); } finally {
      DAW.wav.exportOptions.bitDepth = 16;
      DAW.wav.exportOptions.sampleRate = 0;
      DAW.objects.clear();
      DAW.audio.resetNodes();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

admSuite('[44] ADM書き出し', async (okf) => {
  const O = DAW.objects;
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;

  // ---- パースヘルパ ----
  const tag4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const readStrN = (dv, o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = dv.getUint8(o + i);
      if (c) s += String.fromCharCode(c);
    }
    return s;
  };
  const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;
  // BW64 のチャンク一覧（data のサイズは -1 なので ds64 から取る）
  const parseBw64 = ab => {
    const dv = new DataView(ab);
    const out = { magic: tag4(dv, 0), sizeField: dv.getUint32(4, true), wave: tag4(dv, 8), chunks: {} };
    let pos = 12;
    while (pos + 8 <= dv.byteLength) {
      const id = tag4(dv, pos);
      let size = dv.getUint32(pos + 4, true);
      if (size === 0xFFFFFFFF && out.chunks.ds64) size = u64(dv, out.chunks.ds64.offset + 8);
      out.chunks[id.trim()] = { offset: pos + 8, size };
      pos += 8 + size + (size & 1);
    }
    return out;
  };
  const fmtOf = (dv, o) => ({
    tag: dv.getUint16(o, true), ch: dv.getUint16(o + 2, true), sr: dv.getUint32(o + 4, true),
    blockAlign: dv.getUint16(o + 12, true), bits: dv.getUint16(o + 14, true),
  });
  const readI24 = (dv, o) => {
    let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    return v >= 0x800000 ? v - 0x1000000 : v;
  };
  // "hh:mm:ss.fffff" -> 秒
  const parseT = s => {
    const m = /^(\d{2}):(\d{2}):(\d{2})\.(\d{5})$/.exec(s);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1e5 : NaN;
  };
  const parseAxml = (ab, chunk) => {
    const xml = new TextDecoder().decode(new Uint8Array(ab, chunk.offset, chunk.size)).replace(/\0+$/, '');
    return new DOMParser().parseFromString(xml, 'application/xml');
  };
  const els = (doc, name) => [...doc.getElementsByTagName(name)];
  const lastAb = async () => await H.downloads[H.downloads.length - 1].blob.arrayBuffer();

  // ---- 素材: 一定振幅 0.5 のモノラル 0.2 秒 ----
  const mkTrack = (name, amp, dur) => {
    const track = DAW.addTrack(name);
    const buf = ctx0.createBuffer(1, Math.round(SRT * dur), SRT);
    buf.getChannelData(0).fill(amp);
    const bid = DAW.registerBuffer(buf);
    track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: dur, name, fadeIn: 0, fadeOut: 0 });
    return track;
  };
  const track1 = mkTrack('T1', 0.5, 0.2);
  const obj1 = O.create('音源A', track1.id);
  O.setPosition(obj1.id, 30, 10, 0.5);

  // ---- A. 静止オブジェクトの ADM (BW64) ----
  H.downloads.length = 0;
  await DAW.adm.exportAdm();
  {
    okf('M.1 mix.adm.wav がダウンロードされる',
      H.downloads.length === 1 && H.downloads[0].filename === 'mix.adm.wav',
      H.downloads.map(d => d.filename).join(','));
    const ab = await lastAb();
    const bw = parseBw64(ab);
    const dv = new DataView(ab);
    okf('M.2 BW64 ヘッダ（magic / サイズフィールドは -1）',
      bw.magic === 'BW64' && bw.wave === 'WAVE' && bw.sizeField === 0xFFFFFFFF,
      `${bw.magic}/${bw.wave} size=0x${bw.sizeField.toString(16)}`);
    okf('M.3 ds64 が実サイズを持つ',
      bw.chunks.ds64 && u64(dv, bw.chunks.ds64.offset) === ab.byteLength - 8,
      bw.chunks.ds64 ? `bw64Size=${u64(dv, bw.chunks.ds64.offset)} 実際=${ab.byteLength - 8}` : 'ds64 無し');
    const f = fmtOf(dv, bw.chunks.fmt.offset);
    okf('M.4 fmt は 24bit PCM・1ch（オブジェクト数）・ライブと同一レート',
      f.tag === 1 && f.bits === 24 && f.ch === 1 && f.sr === SRT && f.blockAlign === 3, JSON.stringify(f));
    const frames = bw.chunks.data.size / f.blockAlign;
    okf('M.5 data の実サイズ（ds64 経由）が 0.2 秒ぶん',
      Math.abs(frames - Math.ceil(0.2 * SRT)) <= 1 && u64(dv, bw.chunks.ds64.offset + 8) === bw.chunks.data.size,
      `frames=${frames}`);

    // chna: UID とフォーマット参照の対応
    const co = bw.chunks.chna.offset;
    okf('M.6 chna の numTracks / numUIDs',
      dv.getUint16(co, true) === 1 && dv.getUint16(co + 2, true) === 1,
      `tracks=${dv.getUint16(co, true)} uids=${dv.getUint16(co + 2, true)}`);
    const trackIndex = dv.getUint16(co + 4, true);
    const uid = readStrN(dv, co + 6, 12);
    const trackRef = readStrN(dv, co + 18, 14);
    const packRef = readStrN(dv, co + 32, 11);
    okf('M.7 chna エントリ（trackIndex=1 / ATU / AT / AP）',
      trackIndex === 1 && uid === 'ATU_00000001' && trackRef === 'AT_00031001_01' && packRef === 'AP_00031001',
      `${trackIndex} ${uid} ${trackRef} ${packRef}`);

    // axml: 要素と座標値
    const doc = parseAxml(ab, bw.chunks.axml);
    okf('M.8 axml が XML としてパースできる', els(doc, 'parsererror').length === 0);
    okf('M.9 audioProgramme と audioContent がある',
      els(doc, 'audioProgramme').length === 1 && els(doc, 'audioContent').length === 1
      && els(doc, 'audioContent')[0].getAttribute('audioContentName') === '音源A');
    const ao = els(doc, 'audioObject')[0];
    okf('M.10 audioObject が pack と trackUID を参照する',
      ao && ao.getElementsByTagName('audioPackFormatIDRef')[0].textContent === 'AP_00031001'
      && ao.getElementsByTagName('audioTrackUIDRef')[0].textContent === 'ATU_00000001',
      ao ? ao.getAttribute('audioObjectID') : '無し');
    const pack = els(doc, 'audioPackFormat')[0];
    const chf = els(doc, 'audioChannelFormat')[0];
    okf('M.11 pack / channelFormat は type Objects（typeLabel 0003）',
      pack && pack.getAttribute('typeDefinition') === 'Objects' && pack.getAttribute('typeLabel') === '0003'
      && chf && chf.getAttribute('typeDefinition') === 'Objects');
    const blocks = els(doc, 'audioBlockFormat');
    okf('M.12 静止オブジェクトは audioBlockFormat 1 個', blocks.length === 1, `${blocks.length} 個`);
    const posOf = (b, coord) => {
      const p = [...b.getElementsByTagName('position')].find(x => x.getAttribute('coordinate') === coord);
      return p ? +p.textContent : NaN;
    };
    okf('M.13 座標値（az=30 / el=10 / dist=0.5）と distance の出力',
      Math.abs(posOf(blocks[0], 'azimuth') - 30) < 1e-6 && Math.abs(posOf(blocks[0], 'elevation') - 10) < 1e-6
      && Math.abs(posOf(blocks[0], 'distance') - 0.5) < 1e-6,
      `az=${posOf(blocks[0], 'azimuth')} el=${posOf(blocks[0], 'elevation')} dist=${posOf(blocks[0], 'distance')}`);
    okf('M.14 静止ブロックの rtime=0 / duration=全長',
      Math.abs(parseT(blocks[0].getAttribute('rtime'))) < 1e-5
      && Math.abs(parseT(blocks[0].getAttribute('duration')) - 0.2) < 1e-4,
      `${blocks[0].getAttribute('rtime')} + ${blocks[0].getAttribute('duration')}`);
    const atu = els(doc, 'audioTrackUID')[0];
    okf('M.15 audioTrackUID が chna の UID・sampleRate・bitDepth と整合',
      atu && atu.getAttribute('UID') === uid && +atu.getAttribute('sampleRate') === SRT
      && +atu.getAttribute('bitDepth') === 24);
    okf('M.16 PCM の完全チェーン（stream / trackFormat）がある',
      els(doc, 'audioStreamFormat').length === 1 && els(doc, 'audioTrackFormat').length === 1
      && els(doc, 'audioTrackFormat')[0].getAttribute('audioTrackFormatID') === trackRef);

    // 音声本体: 定位（パン）もリバーブも通らない「素」の値
    const mid = readI24(dv, bw.chunks.data.offset + Math.round(0.1 * SRT) * f.blockAlign);
    const expect = (0.5 * 8388607) | 0;
    okf('M.17 音声は素のモノラル（0.5 がそのまま。パンの 1/√2 が掛からない）',
      Math.abs(mid - expect) <= 2, `実測=${mid} 期待=${expect}±2`);
  }

  // ---- B. 経路あり: audioBlockFormat 列 ----
  // az 0→90 / dist 1→0.5 を 0〜0.1 秒で移動（linear）。20ms 刻み + waypoint 時刻で焼かれる
  O.setPathEnabled(obj1.id, true);
  O.addPathPoint(obj1.id, { t: 0, az: 0, el: 0, dist: 1, ease: 'linear' });
  O.addPathPoint(obj1.id, { t: 0.1, az: 90, el: 0, dist: 0.5, ease: 'linear' });
  H.downloads.length = 0;
  await DAW.adm.exportAdm();
  {
    const ab = await lastAb();
    const bw = parseBw64(ab);
    const doc = parseAxml(ab, bw.chunks.axml);
    const blocks = els(doc, 'audioBlockFormat');
    const posOf = (b, coord) => {
      const p = [...b.getElementsByTagName('position')].find(x => x.getAttribute('coordinate') === coord);
      return p ? +p.textContent : NaN;
    };
    const rt = i => parseT(blocks[i].getAttribute('rtime'));
    const du = i => parseT(blocks[i].getAttribute('duration'));
    // times = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.2] -> 6 ブロック
    okf('P.1 ブロック数 = 20ms 刻み + waypoint + ホールド（6 個）', blocks.length === 6, `${blocks.length} 個`);
    okf('P.2 先頭ブロックは rtime=0 / dur=0.02 / 初期位置 az=0 dist=1',
      Math.abs(rt(0)) < 1e-5 && Math.abs(du(0) - 0.02) < 1e-4
      && Math.abs(posOf(blocks[0], 'azimuth')) < 1e-4 && Math.abs(posOf(blocks[0], 'distance') - 1) < 1e-4,
      `rtime=${rt(0)} dur=${du(0)} az=${posOf(blocks[0], 'azimuth')} dist=${posOf(blocks[0], 'distance')}`);
    okf('P.3 2番目のブロックは区間終端の位置（t=0.04 -> az=36 dist=0.8）',
      Math.abs(rt(1) - 0.02) < 1e-4 && Math.abs(du(1) - 0.02) < 1e-4
      && Math.abs(posOf(blocks[1], 'azimuth') - 36) < 0.01 && Math.abs(posOf(blocks[1], 'distance') - 0.8) < 0.001,
      `rtime=${rt(1)} az=${posOf(blocks[1], 'azimuth')} dist=${posOf(blocks[1], 'distance')}`);
    okf('P.4 waypoint 時刻 0.1 で終端値（az=90 dist=0.5）に到達する',
      Math.abs(rt(4) - 0.08) < 1e-4 && Math.abs(du(4) - 0.02) < 1e-4
      && Math.abs(posOf(blocks[4], 'azimuth') - 90) < 0.01 && Math.abs(posOf(blocks[4], 'distance') - 0.5) < 0.001,
      `rtime=${rt(4)} az=${posOf(blocks[4], 'azimuth')} dist=${posOf(blocks[4], 'distance')}`);
    okf('P.5 最終ブロックは終端までのホールド（rtime=0.1 / dur=0.1 / az=90）',
      Math.abs(rt(5) - 0.1) < 1e-4 && Math.abs(du(5) - 0.1) < 1e-4
      && Math.abs(posOf(blocks[5], 'azimuth') - 90) < 0.01,
      `rtime=${rt(5)} dur=${du(5)} az=${posOf(blocks[5], 'azimuth')}`);
    okf('P.6 ブロックは隙間なく連続する（rtime[i+1] = rtime[i]+dur[i]）',
      blocks.every((b, i) => i === 0 || Math.abs(rt(i) - (rt(i - 1) + du(i - 1))) < 2e-5));
    okf('P.7 全ブロックが distance を持つ',
      blocks.every(b => isFinite(posOf(b, 'distance'))));
  }
  O.setPathEnabled(obj1.id, false);
  obj1.path.points.length = 0;

  // ---- C. 複数オブジェクト + オブジェクト別 WAV 書き出し ----
  const track2 = mkTrack('T2', 0.4, 0.2);
  track2.volume = 0.5;   // トラックゲインが素レンダリングに反映されることの検証用
  const obj2 = O.create('音源B', track2.id);
  O.setPosition(obj2.id, -60, 0, 1);
  const track3 = mkTrack('T3', 0.3, 0.2);   // どのオブジェクトにも割り当てない
  O.create('未割り当て', null);

  H.downloads.length = 0;
  await DAW.adm.exportAdm();
  {
    const ab = await lastAb();
    const bw = parseBw64(ab);
    const dv = new DataView(ab);
    const f = fmtOf(dv, bw.chunks.fmt.offset);
    const co = bw.chunks.chna.offset;
    okf('C.1 割り当て済みオブジェクトだけが書かれる（2ch / chna 2 UID）',
      f.ch === 2 && dv.getUint16(co + 2, true) === 2, `ch=${f.ch} uids=${dv.getUint16(co + 2, true)}`);
    const uid2 = readStrN(dv, co + 4 + 40 + 2, 12);
    okf('C.2 2 本目の UID は ATU_00000002', uid2 === 'ATU_00000002', uid2);
    const doc = parseAxml(ab, bw.chunks.axml);
    okf('C.3 programme が 2 つの content を参照する',
      els(doc, 'audioContentIDRef').length === 2 && els(doc, 'audioObject').length === 2);
    // インターリーブ順 = オブジェクト順。ch2 は 0.4 × トラックゲイン 0.5 = 0.2
    const o = bw.chunks.data.offset + Math.round(0.1 * SRT) * f.blockAlign;
    const s1 = readI24(dv, o);
    const s2 = readI24(dv, o + 3);
    okf('C.4 チャンネル別の振幅（ch1=0.5 / ch2=0.4×0.5）',
      Math.abs(s1 - ((0.5 * 8388607) | 0)) <= 2 && Math.abs(s2 - ((0.2 * 8388607) | 0)) <= 2,
      `ch1=${s1} ch2=${s2}`);
  }

  H.downloads.length = 0;
  await DAW.adm.exportObjects();
  {
    okf('C.5 オブジェクト別 WAV は 1 本ずつダウンロードされる',
      H.downloads.length === 2 && H.downloads[0].filename === '01_音源A.wav'
      && H.downloads[1].filename === '02_音源B.wav',
      H.downloads.map(d => d.filename).join(','));
    const dec = async d => {
      const ab = await d.blob.arrayBuffer();
      const dv = new DataView(ab);
      return { ch: dv.getUint16(22, true), sr: dv.getUint32(24, true), ab, dv };
    };
    const w1 = await dec(H.downloads[0]);
    const w2 = await dec(H.downloads[1]);
    okf('C.6 各ファイルはモノラル・ライブと同一レート',
      w1.ch === 1 && w2.ch === 1 && w1.sr === SRT, `ch=${w1.ch}/${w2.ch} sr=${w1.sr}`);
    // 既定 16bit。データは 44 バイトヘッダの直後
    const mid1 = w1.dv.getInt16(44 + Math.round(0.1 * SRT) * 2, true);
    const mid2 = w2.dv.getInt16(44 + Math.round(0.1 * SRT) * 2, true);
    okf('C.7 長さ 0.2 秒・無音でない・素の振幅（0.5 / 0.2）',
      Math.abs(w1.dv.getUint32(40, true) / 2 - Math.ceil(0.2 * SRT)) <= 1
      && Math.abs(mid1 - ((0.5 * 32767) | 0)) <= 2 && Math.abs(mid2 - ((0.2 * 32767) | 0)) <= 2,
      `mid1=${mid1} mid2=${mid2}`);
  }

  // ミュートしたオブジェクトは無音チャンネルとして書かれる（メタデータは残る）
  O.set(obj2.id, 'mute', true);
  H.downloads.length = 0;
  await DAW.adm.exportObjects();
  {
    const ab = await H.downloads[1].blob.arrayBuffer();
    const dv = new DataView(ab);
    const mid = dv.getInt16(44 + Math.round(0.1 * SRT) * 2, true);
    okf('C.8 ミュートしたオブジェクトは無音になる', mid === 0, `mid=${mid}`);
  }
  O.set(obj2.id, 'mute', false);

  // ---- D. 書き出せるものが無いときは alert ----
  {
    const saved = DAW.objects.list;
    DAW.objects.list = saved.filter(o => !o.trackId);   // 未割り当てだけ残す
    H.downloads.length = 0;
    await DAW.adm.exportAdm();
    const alerts = takeAlerts();
    okf('D.1 割り当てが無ければ alert して何も書き出さない',
      alerts.length === 1 && H.downloads.length === 0, alerts.join('|'));
    DAW.objects.list = saved;
  }

  okf('D.2 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
