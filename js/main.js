'use strict';

window.addEventListener('DOMContentLoaded', () => {
  DAW.ui.init();

  // 初期プロジェクト
  DAW.addTrack();
  DAW.addTrack();
  DAW.ui.renderTracks();
  DAW.history.reset();

  const $ = id => document.getElementById(id);

  // トランスポート
  $('btn-play').addEventListener('click', async () => {
    if (DAW.audio.playing) DAW.audio.pause();
    else await DAW.audio.play();
    DAW.ui.updatePlayButton();
  });
  $('btn-stop').addEventListener('click', async () => {
    if (DAW.record.active) await DAW.ui.toggleRecord();
    DAW.audio.stop();
    DAW.ui.updatePlayButton();
  });
  $('btn-record').addEventListener('click', () => DAW.ui.toggleRecord());
  $('btn-loop').addEventListener('click', () => DAW.ui.toggleLoop());
  $('master-vol').addEventListener('input', e => {
    DAW.project.masterVolume = +e.target.value;
    if (DAW.audio.ctx) DAW.audio.setMasterVolume(+e.target.value);
  });
  $('master-vol').addEventListener('change', () => DAW.history.commit());

  // トラック追加
  $('btn-add-track').addEventListener('click', () => {
    DAW.addTrack();
    DAW.ui.renderTracks();
    DAW.history.commit();
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
      DAW.ui.updateExportLabel();
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
      DAW.ui.els.btnLoop.classList.toggle('on', DAW.loop.enabled);
      DAW.ui.updateExportLabel();
      DAW.history.reset();
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
      DAW.ui.deleteSelectedClip();
    } else if (e.code === 'KeyL' && !e.ctrlKey && !e.metaKey) {
      DAW.ui.toggleLoop();
    } else if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
      DAW.ui.toggleMetronome();
    } else if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      await DAW.ui.toggleRecord();
    } else if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
      // 選択中のクリップを再生ヘッド位置で分割（右クリックメニュー・分割ボタンと同じ経路）
      DAW.ui.splitSelectedClip();
    } else if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey)) {
      DAW.ui.copySelectedClip();
    } else if (e.code === 'KeyX' && (e.ctrlKey || e.metaKey)) {
      DAW.ui.cutSelectedClip();
    } else if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) {
      DAW.ui.pasteClipAt(DAW.audio.getPos());
    } else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      DAW.ui.duplicateSelectedClip();
    } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) await DAW.history.redo();
      else await DAW.history.undo();
    } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      await DAW.history.redo();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const dir = e.code === 'ArrowRight' ? 1 : -1;
      const step = DAW.nudgeStep() * (e.shiftKey ? 5 : 1);
      if (e.altKey && DAW.ui.selectedClipId) {
        // Alt+矢印: 選択中のクリップをずらす
        if (DAW.nudgeClip(DAW.ui.selectedClipId, dir * step)) {
          DAW.ui.renderTracks();
          DAW.audio.reschedule();
          DAW.history.commit();
        }
      } else {
        DAW.audio.seek(Math.max(0, DAW.audio.getPos() + dir * step));
      }
    } else if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && e.altKey && DAW.ui.selectedClipId) {
      // Alt+上下: 選択中のクリップを隣のトラックへ移す
      e.preventDefault();
      if (DAW.moveClipToTrack(DAW.ui.selectedClipId, e.code === 'ArrowDown' ? 1 : -1)) {
        DAW.ui.renderTracks();
        DAW.audio.reschedule();
        DAW.history.commit();
      }
    } else if (e.code === 'Home') {
      DAW.audio.seek(0);
    } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault();
      DAW.ui.zoomBy(1.5);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      DAW.ui.zoomBy(1 / 1.5);
    } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
      e.preventDefault();
      DAW.ui.zoomToFit();
    }
  });
});
