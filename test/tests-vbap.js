'use strict';
// =====================================================================
// スピーカー出力（VBAP。5.1 / 7.1.4）のテスト。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function vbapSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const savedMode = DAW.objaudio.mode, savedLayout = DAW.objaudio.layoutName, savedAuto = DAW.objaudio.autoHrtf;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.objaudio.autoHrtf = false;
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objaudio.autoHrtf = savedAuto;
      DAW.objaudio.layoutName = savedLayout;
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

vbapSuite('[30] スピーカー出力（VBAP）', async (okf) => {
  const OA = DAW.objaudio;
  const near4 = (a, b, t) => Math.abs(a - b) <= t;
  const layout51 = OA.LAYOUTS['5.1'];
  const layout714 = OA.LAYOUTS['7.1.4'];
  const idx = (layout, name) => layout.findIndex(s => s.name === name);
  const g51 = (az, el) => OA.vbapGains(az, el, layout51);
  const g714 = (az, el) => OA.vbapGains(az, el, layout714);

  // ---- 配置の定義 ----
  okf('V.1 5.1 は6本（LFE込み）', layout51.length === 6, layout51.map(s => s.name).join(','));
  okf('V.2 7.1.4 は12本', layout714.length === 12, layout714.map(s => s.name).join(','));
  okf('V.3 WAV の標準チャンネル順（L,R,C,LFE,...）',
    layout51.slice(0, 4).map(s => s.name).join(',') === 'L,R,C,LFE');
  okf('V.4 上層は4本（Ltf,Rtf,Ltr,Rtr）', layout714.filter(s => s.el >= 25).length === 4);
  okf('V.5 出力チャンネル数がモードで変わる',
    (OA.setModeQuiet(OA.MODE_SPEAKERS), OA.outputChannels() === 6)
    && (OA.setLayout('7.1.4'), OA.outputChannels() === 12)
    && (OA.setLayout('5.1'), OA.outputChannels() === 6),
    `5.1=${6} 7.1.4=${12}`);
  OA.setModeQuiet(OA.MODE_EQUALPOWER);
  okf('V.6 バイノーラル/等パワーは2ch', OA.outputChannels() === 2);

  // ---- 5.1 のゲイン ----
  {
    const L = idx(layout51, 'L'), R = idx(layout51, 'R'), C = idx(layout51, 'C'),
      LFE = idx(layout51, 'LFE'), Ls = idx(layout51, 'Ls'), Rs = idx(layout51, 'Rs');
    let g = g51(30, 0);
    okf('V.7 az=+30 は L のみ', near4(g[L], 1, 1e-6) && g.every((v, i) => i === L || near4(v, 0, 1e-6)),
      g.map(v => v.toFixed(3)).join(','));
    g = g51(0, 0);
    okf('V.8 az=0 は C のみ', near4(g[C], 1, 1e-6), g.map(v => v.toFixed(3)).join(','));
    g = g51(-30, 0);
    okf('V.9 az=-30 は R のみ', near4(g[R], 1, 1e-6), g.map(v => v.toFixed(3)).join(','));
    g = g51(70, 0);
    okf('V.10 L と Ls の中間は両方鳴る', g[L] > 0.3 && g[Ls] > 0.3 && near4(g[L] ** 2 + g[Ls] ** 2, 1, 1e-6),
      `L=${g[L].toFixed(3)} Ls=${g[Ls].toFixed(3)}`);
    okf('V.11 LFE には送らない', [0, 30, 90, 180, -90].every(a => near4(g51(a, 0)[LFE], 0, 1e-9)));
    okf('V.12 どの方位でもパワー和は1',
      [0, 15, 30, 70, 110, 180, -30, -110].every(a => {
        const gg = g51(a, 0);
        return near4(gg.reduce((s, v) => s + v * v, 0), 1, 1e-6);
      }));
    g = g51(0, 45);
    okf('V.13 上層が無い配置では仰角は水平面へ落ちる', near4(g[C], 1, 1e-6), g.map(v => v.toFixed(3)).join(','));
    g = g51(180, 0);
    okf('V.14 真後ろは Ls と Rs に分かれる', g[Ls] > 0.5 && g[Rs] > 0.5,
      `Ls=${g[Ls].toFixed(3)} Rs=${g[Rs].toFixed(3)}`);
  }

  // ---- 7.1.4 のゲイン ----
  {
    const Ltf = idx(layout714, 'Ltf'), L = idx(layout714, 'L'), C = idx(layout714, 'C');
    let g = g714(45, 45);
    okf('V.15 az=45, el=45 は Ltf のみ', near4(g[Ltf], 1, 1e-6), `Ltf=${g[Ltf].toFixed(3)}`);
    g = g714(45, 0);
    okf('V.16 仰角0では上層に送らない', near4(g[Ltf], 0, 1e-6), `Ltf=${g[Ltf].toFixed(3)}`);
    g = g714(45, 22.5);
    okf('V.17 中間の仰角は上下の層に分かれる', g[Ltf] > 0.4 && (g[L] > 0.3 || g[C] > 0.3),
      `Ltf=${g[Ltf].toFixed(3)} L=${g[L].toFixed(3)} C=${g[C].toFixed(3)}`);
    okf('V.18 どの位置でもパワー和は1',
      [[0, 0], [45, 30], [120, 45], [-90, 10], [180, 45]].every(([a, e]) => {
        const gg = g714(a, e);
        return near4(gg.reduce((s, v) => s + v * v, 0), 1, 1e-6);
      }));
  }

  // ---- 書き出し（多チャンネル） ----
  {
    const ctx0 = DAW.audio.ensureCtx();
    const SRT = ctx0.sampleRate;
    const buf = ctx0.createBuffer(1, SRT / 2, SRT);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
    const bid = DAW.registerBuffer(buf);
    const track = DAW.project.tracks[0];
    track.clips = [{ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 0.5, name: 'c', fadeIn: 0, fadeOut: 0 }];
    const obj = DAW.objects.create('o', track.id);
    H.confirmResult = true;

    const renderCh = async () => {
      H.downloads.length = 0;
      await DAW.wav.exportMix();
      const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
      const dv = new DataView(ab);
      return { ch: dv.getUint16(22, true), sr: dv.getUint32(24, true), bytes: ab };
    };
    const rmsOfCh = (ab, ch, nch) => {
      // 16bit PCM を直接読む（多チャンネルは decodeAudioData がステレオへ畳むため）
      const dv = new DataView(ab);
      const frames = (ab.byteLength - 44) / (nch * 2);
      let s = 0;
      for (let i = Math.round(frames * 0.1); i < Math.round(frames * 0.9); i++) {
        const v = dv.getInt16(44 + (i * nch + ch) * 2, true) / 32768;
        s += v * v;
      }
      return Math.sqrt(s / (frames * 0.8));
    };

    OA.setModeQuiet(OA.MODE_SPEAKERS);
    OA.setLayout('5.1');
    DAW.objects.setPosition(obj.id, 30, 0, 1);
    let r = await renderCh();
    okf('V.19 5.1 では 6ch の WAV を書き出す', r.ch === 6, `${r.ch}ch`);
    okf('V.20 az=+30 の音は L チャンネルにだけ出る',
      rmsOfCh(r.bytes, 0, 6) > 0.2 && rmsOfCh(r.bytes, 1, 6) < 0.01 && rmsOfCh(r.bytes, 2, 6) < 0.01,
      `L=${rmsOfCh(r.bytes, 0, 6).toFixed(4)} R=${rmsOfCh(r.bytes, 1, 6).toFixed(4)} C=${rmsOfCh(r.bytes, 2, 6).toFixed(4)}`);
    okf('V.21 LFE は無音', rmsOfCh(r.bytes, 3, 6) < 0.001, rmsOfCh(r.bytes, 3, 6).toExponential(2));

    DAW.objects.setPosition(obj.id, -110, 0, 1);
    r = await renderCh();
    okf('V.22 az=-110 の音は Rs チャンネルへ',
      rmsOfCh(r.bytes, 5, 6) > 0.2 && rmsOfCh(r.bytes, 0, 6) < 0.01,
      `Rs=${rmsOfCh(r.bytes, 5, 6).toFixed(4)} L=${rmsOfCh(r.bytes, 0, 6).toFixed(4)}`);

    OA.setLayout('7.1.4');
    DAW.objects.setPosition(obj.id, 45, 45, 1);
    r = await renderCh();
    okf('V.23 7.1.4 では 12ch の WAV を書き出す', r.ch === 12, `${r.ch}ch`);
    okf('V.24 az=45,el=45 の音は Ltf（9ch目）へ',
      rmsOfCh(r.bytes, 8, 12) > 0.2 && rmsOfCh(r.bytes, 0, 12) < 0.02,
      `Ltf=${rmsOfCh(r.bytes, 8, 12).toFixed(4)} L=${rmsOfCh(r.bytes, 0, 12).toFixed(4)}`);

    OA.setLayout('5.1');
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    r = await renderCh();
    okf('V.25 バイノーラル/等パワーに戻すと 2ch に戻る', r.ch === 2, `${r.ch}ch`);
  }

  // ---- ライブのノード構成 ----
  {
    OA.setModeQuiet(OA.MODE_SPEAKERS);
    await DAW.audio.play();
    const n = OA.live.get(DAW.objects.list[0].id);
    const pt = n && n.points[0];
    okf('V.26 スピーカーモードでは配置ぶんのゲインが作られる', !!pt && pt.spk && pt.spk.length === 6,
      pt && pt.spk ? `${pt.spk.length}本` : 'なし');
    okf('V.27 自動 HRTF 切替はスピーカー選択時に働かない', OA.wantedMode(true) === OA.MODE_SPEAKERS);
    DAW.audio.stop();
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
  }
  okf('V.28 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
