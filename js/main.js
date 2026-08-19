'use strict';

window.addEventListener('DOMContentLoaded', () => {
  DAW.ui.init();

  // 初期プロジェクト
  DAW.addTrack();
  DAW.addTrack();
  DAW.ui.renderTracks();

  const $ = id => document.getElementById(id);

  // トランスポート
  $('btn-play').addEventListener('click', async () => {
    if (DAW.audio.playing) DAW.audio.pause();
    else await DAW.audio.play();
    DAW.ui.updatePlayButton();
  });
  $('btn-stop').addEventListener('click', () => {
    DAW.audio.stop();
    DAW.ui.updatePlayButton();
  });
  $('master-vol').addEventListener('input', e => {
    DAW.project.masterVolume = +e.target.value;
    if (DAW.audio.ctx) DAW.audio.setMasterVolume(+e.target.value);
  });

  // トラック追加
  $('btn-add-track').addEventListener('click', () => {
    DAW.addTrack();
    DAW.ui.renderTracks();
  });

  // 音声読み込み（各ファイルを新規トラックに、再生ヘッド位置へ配置）
  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const file of files) {
      const track = DAW.addTrack(file.name.replace(/\.[^.]+$/, ''));
      await DAW.ui.importFiles([file], track, DAW.audio.getPos());
    }
  });

  // 書き出し
  $('btn-export').addEventListener('click', async e => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '書き出し中…';
    try {
      await DAW.wav.exportMix();
    } finally {
      btn.disabled = false;
      btn.textContent = 'WAV書き出し';
    }
  });

  // 保存 / 開く
  $('btn-save').addEventListener('click', () => DAW.wav.saveProject());
  $('btn-open').addEventListener('click', () => $('project-input').click());
  $('project-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (await DAW.wav.loadProject(file)) {
      $('master-vol').value = DAW.project.masterVolume;
      DAW.ui.selectedClipId = null;
      DAW.ui.renderTracks();
      DAW.ui.updatePlayButton();
    }
  });

  // キーボードショートカット
  document.addEventListener('keydown', async e => {
    const t = e.target;
    const isText = (t.tagName === 'INPUT' && !['range', 'checkbox'].includes(t.type)) || t.tagName === 'TEXTAREA';
    if (isText) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (DAW.audio.playing) DAW.audio.pause();
      else await DAW.audio.play();
      DAW.ui.updatePlayButton();
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      if (DAW.ui.selectedClipId) {
        DAW.removeClip(DAW.ui.selectedClipId);
        DAW.ui.selectedClipId = null;
        DAW.ui.renderTracks();
        DAW.audio.reschedule();
      }
    } else if (e.code === 'Home') {
      DAW.audio.seek(0);
    }
  });
});
