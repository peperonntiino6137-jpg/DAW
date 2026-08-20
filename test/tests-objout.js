'use strict';
// =====================================================================
// RENDERER 画面の「出力形式」切り替え（UI → レンダラー層）のテスト。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function outSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const savedMode = DAW.objaudio.mode, savedLayout = DAW.objaudio.layoutName;
    const savedView = DAW.objui && DAW.objui.view;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.addTrack('t');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objaudio.setModeQuiet(savedMode);
      DAW.objaudio.layoutName = savedLayout;
      if (DAW.objui && savedView) DAW.objui.setView(savedView);
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

outSuite('[33] 出力形式の切り替え', async (okf) => {
  const UI = DAW.objui, OA = DAW.objaudio;
  okf('R.1 objui が読み込まれている', !!UI && typeof UI.setOutMode === 'function');
  UI.setView('renderer');

  OA.setModeQuiet(OA.MODE_EQUALPOWER);
  UI.render();
  okf('R.2 等パワー/HRTF はバイノーラル表示', UI.outMode() === 'binaural', UI.outMode());

  const btn = key => document.querySelector(`#obj-out button[data-out="${key}"]`);
  okf('R.3 出力形式のボタンが2つある', !!btn('binaural') && !!btn('speakers'));
  okf('R.4 現在の形式が選択表示になる', btn('binaural').classList.contains('on') && !btn('speakers').classList.contains('on'));

  btn('speakers').click();
  okf('R.5 スピーカーを選ぶとレンダラー層が切り替わる', OA.mode === OA.MODE_SPEAKERS, OA.mode);
  okf('R.6 表示も追従する', btn('speakers').classList.contains('on') && !btn('binaural').classList.contains('on'));
  okf('R.7 出力チャンネル数が配置に合う', OA.outputChannels() === OA.layout().length, `${OA.outputChannels()}ch`);

  // 配置の切り替えがそのまま出力チャンネル数に効く
  const layoutBtn = name => document.querySelector(`#obj-layouts button[data-layout="${name}"]`);
  if (layoutBtn('7.1.4')) {
    layoutBtn('7.1.4').click();
    okf('R.8 配置を 7.1.4 にすると 12ch になる', OA.layoutName === '7.1.4' && OA.outputChannels() === 12,
      `${OA.layoutName} / ${OA.outputChannels()}ch`);
    layoutBtn('5.1').click();
    okf('R.9 5.1 に戻すと 6ch', OA.layoutName === '5.1' && OA.outputChannels() === 6);
  }

  btn('binaural').click();
  okf('R.10 バイノーラルへ戻せる', OA.mode === OA.MODE_EQUALPOWER && UI.outMode() === 'binaural', OA.mode);
  okf('R.11 戻すと 2ch', OA.outputChannels() === 2);

  // UI を経由しない変更にも追従する（stateSig に mode を入れてある）
  {
    const before = UI.stateSig();
    OA.setModeQuiet(OA.MODE_SPEAKERS);
    okf('R.12 レンダラー層側で切り替えても UI が追従する', UI.stateSig() !== before, '署名が変化する');
    UI.render();
    okf('R.13 追従後の表示', btn('speakers').classList.contains('on'));
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    UI.render();
  }

  // 再生中の切り替えでも落ちない
  {
    const ctx0 = DAW.audio.ensureCtx();
    const buf = ctx0.createBuffer(1, ctx0.sampleRate, ctx0.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin(2 * Math.PI * 330 * i / ctx0.sampleRate);
    const track = DAW.project.tracks[0];
    track.clips = [{ id: DAW.uid(), bufferId: DAW.registerBuffer(buf), startTime: 0, offset: 0, duration: 1, name: 'c', fadeIn: 0, fadeOut: 0 }];
    DAW.objects.create('o', track.id);
    await DAW.audio.play();
    btn('speakers').click();
    okf('R.14 再生中に切り替えても再生は続く', DAW.audio.isPlaying() === true && OA.mode === OA.MODE_SPEAKERS);
    btn('binaural').click();
    okf('R.15 戻しても再生は続く', DAW.audio.isPlaying() === true);
    DAW.audio.stop();
  }
  okf('R.16 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
