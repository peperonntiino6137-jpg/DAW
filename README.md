# DAW

ブラウザだけで動くシンプルなマルチトラック DAW。ビルド不要・依存ゼロの純粋な HTML/CSS/JS。

## 使い方

`index.html` をダブルクリックして Chrome / Edge で開くだけ。サーバー不要（file:// で動作）。

- **読み込み**: 音声ファイル（WAV / MP3 / OGG など）をタイムラインにドラッグ&ドロップ、または「音声を読み込み」ボタン
- **再生**: ▶ ボタンまたは Space キー。ルーラーやレーンの空白をクリックでシーク、Home で先頭へ
- **クリップ編集**: ドラッグで移動（上下でトラック間移動）、端をドラッグでトリム、クリックで選択して Delete キーか × で削除
- **トラック**: 音量 / パン / M（ミュート）/ S（ソロ）、＋FX でエフェクト追加
- **WAV書き出し**: 全トラックをミックスして `mix.wav` をダウンロード
- **保存 / 開く**: プロジェクトを JSON 1 ファイルで保存・復元（音声データも埋め込み）

## 配布

3 通り:

1. **DAW.exe（推奨）** — exe 1 個を渡すだけ。アプリ全ファイルを内蔵し、起動時に `%LOCALAPPDATA%\DAW\app` へ展開して Edge / Chrome のアプリモード（単独ウィンドウ）で開く。追加インストール不要
2. フォルダごと zip して渡す（`index.html` をダブルクリック）
3. GitHub Pages などの静的ホスティングにそのまま置く

### DAW.exe のビルド

```
powershell -ExecutionPolicy Bypass -File build\build-exe.ps1
```

Windows 標準の csc.exe（.NET Framework）だけでビルドできる。ツールのインストール不要。**HTML/CSS/JS を変更したら再ビルドすること**（exe はビルド時点のファイルを内蔵するため）。

## プラグインの追加

1. `js/plugins/` に JS ファイルを作り、`DAW.plugins.register({...})` を呼ぶ
2. `index.html` の末尾に `<script src="js/plugins/xxx.js"></script>` を 1 行追加

```js
DAW.plugins.register({
  id: 'mygain',                    // 一意なID（プロジェクト保存に使われる）
  name: 'ゲイン',                   // UI表示名
  params: [                        // スライダーが自動生成される
    { key: 'amount', label: '量', min: 0, max: 2, step: 0.01, default: 1 },
  ],
  create(ctx, params) {            // ctx は AudioContext / OfflineAudioContext 両対応にする
    const g = ctx.createGain();
    g.gain.value = params.amount;
    return {
      input: g,                    // チェーンの入口ノード
      output: g,                   // 出口ノード
      set(key, v) {                // パラメータのライブ変更
        g.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
      },
    };
  },
});
```

エフェクトはトラックごとに「Gain →（FXチェーン）→ Pan」の位置に直列で挿入され、WAV 書き出しにも反映される。同梱プラグイン: `lowpass.js`（ローパス）、`delay.js`（ディレイ）、`eq.js`（7バンド グラフィックEQ）、`dyneq.js`（3バンド パラメトリック/ダイナミックEQ）。

AudioWorklet など非同期初期化が必要なプラグインは、オプションの `prepare(ctx)`（Promise を返す）を定義できる。core が再生・書き出し・読み込み・FX追加の前に await してから `create()` を呼ぶ。実装例は `dyneq.js` を参照（Worklet モジュールを Blob URL でロードするので file:// でも動く）。

## 制限事項

- プロジェクト保存は音声を 16bit WAV → base64 で埋め込むため、ファイルサイズは元の音声より大きくなる。合計 10 分を超えるような音声を含むプロジェクトの保存は非推奨
- ズーム・BPM グリッド・録音は未対応（構造上追加しやすい設計にはなっている）
