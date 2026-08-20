# DAW ステム分離サイドカー (demucs / CPU)

ブラウザ (file:// の DAW) から `http://127.0.0.1:8787` に fetch してステム分離を
ネイティブ Python (demucs 4.1.0, htdemucs) に委譲するローカルサーバ。

起動しておくと、DAW のステム分離が自動でこちらを検出して使う
（進捗ダイアログに「Python 高速処理」と表示される）。起動していなければ
従来どおりブラウザ内 (onnxruntime-web) で分離する（表示は「ブラウザ内処理」）。
**開発者向けオプション**であり、DAW.exe には同梱しない。

## セットアップ / 起動

`start-sidecar.bat` をダブルクリック（または端末で実行）するだけ。初回は自動で:

1. venv を `%LOCALAPPDATA%\daw-stems-venv` に作成
2. `pip install demucs numpy`（約 700 MB。**demucs 4.1.0 は numpy を依存宣言して
   いない**ので両方明示する必要がある）
3. サーバを `http://127.0.0.1:8787` で起動

初回の分離時に htdemucs モデル（約 80 MB）を HuggingFace から自動ダウンロードする
（キャッシュ先: `%USERPROFILE%\.cache\huggingface\hub\models--adefossez--HTDemucs`）。
止めるには Ctrl+C かウィンドウを閉じる。Python 3 が必要（`python` か `py -3`）。

## 重要: venv の置き場所と MAX_PATH（260 文字制限）

torch の venv 内パス（ヘッダやネイティブライブラリ）は非常に深く、venv を長い
ディレクトリ配下に作ると Windows の MAX_PATH（260 文字）を超えて**作成も動作も
失敗する**。対策として venv は短い実パス `%LOCALAPPDATA%\daw-stems-venv` に置く。

以前はリポジトリ内の venv へ短いジャンクションを張る方式だったが、
「venv をはじめから短い実パスに作る」ほうが構成が単純（ジャンクションの作成・
張り替え・削除の面倒がない）なのでこちらに変更した。恒久対策はレジストリ
`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=1`（要管理者）
だが、本セットアップではシステム設定は変更しない。

## API

すべて `Access-Control-Allow-Origin: *` 付き。127.0.0.1 バインドのみ。
同時に走る分離は 1 件だけ（2件目は 409）。

| エンドポイント | 説明 |
|---|---|
| `GET /ping` | `{"ok":true,"version":"4.1.0","model":"htdemucs","busy":false}` |
| `GET /progress` | `{"running":bool,"progress":0..1,"stage":"idle/loading/separating/encoding/done/error/cancelled","error":null}` |
| `POST /separate[?model=htdemucs]` | body = WAV バイナリ。200 = DAWS フレーミング(下記)。409 = 実行中、499 = キャンセル、400/500 = JSON エラー |
| `POST /cancel` | 実行中の demucs プロセスを kill。`{"ok":true,"cancelled":bool}` |

### /separate レスポンス形式 (DAWS フレーミング, application/octet-stream)

```
[0..3]   magic "DAWS"
[4..7]   uint32 LE = JSON ヘッダ長 N
[8..8+N] JSON: {"stems":[{"name":"drums","offset":0,"length":...}, ...]}
         (offset はペイロード先頭からの相対)
[8+N..]  各ステムの WAV (int16 PCM) を連結
```

ステム順は drums / bass / other / vocals。ブラウザ側のパース実装は
`js/stems.js` の `DAW.stems.backends.python.parseFrame()`
（最小例は sidecar.py 冒頭の docstring）。

## 実測 (2026-08-20, CPU)

- 30 秒ステレオ WAV → 4 ステム: HTTP ラウンドトリップ 約 14 秒
  （コールド初回はモデルロード込みで約 27 秒）
- 3〜4 分曲の推定: 約 1.5〜2.5 分（ブラウザ内処理の数分の一。処理時間はほぼ曲長に
  線形、実測レート ≈ 曲長の 0.45〜0.5 倍 + 固定費数秒）
- ピークメモリ: サイドカー + demucs 子プロセス合計 約 1.2 GB（30 秒素材）
- レスポンスサイズ: 入力 WAV の約 4 倍（4 ステム分の int16 WAV 連結）
- venv サイズ: 約 694 MB（torch CPU 含む）

## ファイル

- `sidecar.py` — サーバ本体（stdlib のみ、demucs は subprocess 呼び出し）
- `start-sidecar.bat` — venv 作成 + 依存導入 + サーバ起動（自己完結。メッセージは
  コードページ差で化けないよう ASCII のみ）
- `test_sidecar.py` — スモークテスト（テスト WAV を自動生成。サーバ起動が前提なので
  DAW の既定スイート `test/run.sh` からは呼ばない）
