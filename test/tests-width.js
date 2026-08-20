'use strict';
// =====================================================================
// オブジェクトの width（MDAP / 2ソース化）のテスト。
// 仕様: width -200〜+200%、負値は L/R 反転。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function widthSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const savedMode = DAW.objaudio.mode, savedAuto = DAW.objaudio.autoHrtf;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.objaudio.autoHrtf = false;
    DAW.objaudio.setModeQuiet(DAW.objaudio.MODE_EQUALPOWER);
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objaudio.autoHrtf = savedAuto;
      DAW.objaudio.setModeQuiet(savedMode);
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

widthSuite('[31] オブジェクトの width', async (okf) => {
  const OA = DAW.objaudio, O = DAW.objects;
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;
  const near5 = (a, b, t) => Math.abs(a - b) <= t;

  // ---- 角度への換算 ----
  okf('W.1 width=0 は広がりなし', OA.spreadAngle(0) === 0);
  okf('W.2 width=100% で 90°（±45°）', OA.spreadAngle(100) === 90);
  okf('W.3 width=200% で 180°（±90°）', OA.spreadAngle(200) === 180);
  okf('W.4 負値も同じ幅', OA.spreadAngle(-100) === 90);
  {
    const az = OA.widthAzimuths({ az: 0, width: 100 });
    okf('W.5 正の width は L 成分を左（+45°）へ', az.left === 45 && az.right === -45, JSON.stringify(az));
    const azNeg = OA.widthAzimuths({ az: 0, width: -100 });
    okf('W.6 負の width は L/R が入れ替わる', azNeg.left === -45 && azNeg.right === 45, JSON.stringify(azNeg));
    const azOff = OA.widthAzimuths({ az: 90, width: 100 });
    okf('W.7 中心方位からの相対で広がる', azOff.left === 135 && azOff.right === 45, JSON.stringify(azOff));
  }

  // ---- 実波形での検証（ステレオ素材の L/R を左右へ振り分ける） ----
  // L チャンネルだけに 440Hz、R チャンネルだけに 880Hz を入れて、どちらがどこへ行くか見る
  const buf = ctx0.createBuffer(2, SRT / 2, SRT);
  {
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    for (let i = 0; i < l.length; i++) {
      l[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
      r[i] = 0.5 * Math.sin(2 * Math.PI * 880 * i / SRT);
    }
  }
  const bid = DAW.registerBuffer(buf);
  const track = DAW.project.tracks[0];
  track.clips = [{ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 0.5, name: 'c', fadeIn: 0, fadeOut: 0 }];
  const obj = O.create('o', track.id);
  H.confirmResult = true;

  const render = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
    return new OfflineAudioContext(2, 128, new DataView(ab).getUint32(24, true)).decodeAudioData(ab.slice(0));
  };
  // ある周波数の成分の強さ（素朴なゴルツェル）
  const power = (data, freq, sr) => {
    let re = 0, im = 0;
    const n = Math.min(data.length, Math.round(sr * 0.3));
    for (let i = 0; i < n; i++) {
      const w = 2 * Math.PI * freq * i / sr;
      re += data[i] * Math.cos(w);
      im += data[i] * Math.sin(w);
    }
    return Math.sqrt(re * re + im * im) / n * 2;
  };

  {
    // width=0（点音源）: L/R が混ざって中央に定位する
    O.set(obj.id, 'width', 0);
    O.setPosition(obj.id, 0, 0, 1);
    const m = await render();
    const L = m.getChannelData(0), R = m.getChannelData(1);
    okf('W.8 width=0 では L/R が混ざって中央に出る',
      near5(power(L, 440, m.sampleRate), power(R, 440, m.sampleRate), 0.01)
      && near5(power(L, 880, m.sampleRate), power(R, 880, m.sampleRate), 0.01),
      `440Hz L=${power(L, 440, m.sampleRate).toFixed(3)} R=${power(R, 440, m.sampleRate).toFixed(3)}`);
  }
  {
    // width=200%（±90°）: L 成分は左いっぱい、R 成分は右いっぱいへ
    O.set(obj.id, 'width', 200);
    const m = await render();
    const L = m.getChannelData(0), R = m.getChannelData(1);
    const l440 = power(L, 440, m.sampleRate), r440 = power(R, 440, m.sampleRate);
    const l880 = power(L, 880, m.sampleRate), r880 = power(R, 880, m.sampleRate);
    okf('W.9 width=200% で L 成分（440Hz）が左へ寄る', l440 > r440 * 10,
      `L=${l440.toFixed(3)} R=${r440.toFixed(4)}`);
    okf('W.10 width=200% で R 成分（880Hz）が右へ寄る', r880 > l880 * 10,
      `L=${l880.toFixed(4)} R=${r880.toFixed(3)}`);
  }
  {
    // 負の width: L/R が入れ替わる
    O.set(obj.id, 'width', -200);
    const m = await render();
    const L = m.getChannelData(0), R = m.getChannelData(1);
    okf('W.11 [仕様] 負の width は L/R が入れ替わる',
      power(R, 440, m.sampleRate) > power(L, 440, m.sampleRate) * 10
      && power(L, 880, m.sampleRate) > power(R, 880, m.sampleRate) * 10,
      `440Hz は右へ=${power(R, 440, m.sampleRate).toFixed(3)} / 880Hz は左へ=${power(L, 880, m.sampleRate).toFixed(3)}`);
  }
  {
    // モノラル素材は width を動かしても音量が跳ねない
    const mono = ctx0.createBuffer(1, SRT / 2, SRT);
    const d = mono.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
    const mid = DAW.registerBuffer(mono);
    track.clips = [{ id: DAW.uid(), bufferId: mid, startTime: 0, offset: 0, duration: 0.5, name: 'm', fadeIn: 0, fadeOut: 0 }];
    const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
    // 音量の比較はパワー（L²+R²）で行う
    const power = b => rmsOf(b.getChannelData(0)) ** 2 + rmsOf(b.getChannelData(1)) ** 2;
    const levels = [];
    for (const w of [0, 50, 100, 150, 200, -100, -200]) {
      O.set(obj.id, 'width', w);
      levels.push([w, power(await render())]);
    }
    const base = levels[0][1];
    const worst = Math.max(...levels.map(([, p]) => Math.abs(10 * Math.log10(p / base))));
    okf('W.12 モノラル素材は width を動かしても音量が変わらない（±0.5dB 以内）', worst < 0.5,
      levels.map(([w, p]) => `${w}%:${(10 * Math.log10(p / base)).toFixed(2)}dB`).join(' '));
    O.set(obj.id, 'width', 0);
  }

  {
    // ステレオ素材では width を広げるとパワーが最大 +3dB になる。
    // これは「width=0 で (L+R)/2 に畳んだときに無相関成分が -3dB になる」ぶんが
    // 広げることで戻るためで、仕様どおりの挙動（モノラル素材が一定であることを優先している）。
    const st = ctx0.createBuffer(2, SRT / 2, SRT);
    for (let c = 0; c < 2; c++) {
      const d = st.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * (c ? 880 : 440) * i / SRT);
    }
    const sid = DAW.registerBuffer(st);
    track.clips = [{ id: DAW.uid(), bufferId: sid, startTime: 0, offset: 0, duration: 0.5, name: 's', fadeIn: 0, fadeOut: 0 }];
    const rmsOf2 = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
    const power2 = b => rmsOf2(b.getChannelData(0)) ** 2 + rmsOf2(b.getChannelData(1)) ** 2;
    O.set(obj.id, 'width', 0);
    const p0 = power2(await render());
    O.set(obj.id, 'width', 200);
    const p200 = power2(await render());
    okf('W.12b 無相関のステレオ素材は広げると +3dB 戻る（モノラル畳み込みぶん）',
      Math.abs(10 * Math.log10(p200 / p0) - 3) < 0.5,
      `${(10 * Math.log10(p200 / p0)).toFixed(2)}dB`);
    O.set(obj.id, 'width', 0);
  }

  // ---- ノード構成 ----
  {
    O.set(obj.id, 'width', 0);
    await DAW.audio.play();
    let n = OA.live.get(obj.id);
    okf('W.13 width=0 は1点のチェーン', n.points.length === 1, `points=${n.points.length}`);
    O.set(obj.id, 'width', 120);          // onChange → 構成が変わるので組み直される
    await delay(50);
    n = OA.live.get(obj.id);
    okf('W.14 width≠0 で2ソースに分かれる', !!n && n.points.length === 2, n ? `points=${n.points.length}` : 'なし');
    okf('W.15 2ソースの方位が左右に開く',
      !!n && Math.abs(n.points[0].az - n.points[1].az) === OA.spreadAngle(120),
      n ? `${n.points[0].az} / ${n.points[1].az}` : '');
    DAW.audio.stop();
  }

  // ---- 他の出力形式でも効く ----
  {
    OA.setModeQuiet(OA.MODE_SPEAKERS);
    O.set(obj.id, 'width', 200);
    O.setPosition(obj.id, 0, 0, 1);
    await DAW.audio.play();
    const n = OA.live.get(obj.id);
    okf('W.16 スピーカー出力でも2ソースになる', !!n && n.points.length === 2 && !!n.points[0].spk);
    DAW.audio.stop();
    OA.setModeQuiet(OA.MODE_HRTF);
    await DAW.audio.play();
    const n2 = OA.live.get(obj.id);
    okf('W.17 HRTF でも2ソースになる', !!n2 && n2.points.length === 2 && !!n2.points[0].panner);
    DAW.audio.stop();
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    O.set(obj.id, 'width', 0);
  }
  okf('W.18 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
