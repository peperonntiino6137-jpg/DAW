<!-- このファイルは worktree（paraeq 実装ブランチ）で新規作成。統合時に本体の docs/DEVLOG.md へ追記マージする -->

## 7バンド パラメトリックEQ（`js/plugins/paraeq.js`・2026-08-20）

FL Studio「Parametric EQ 2」の DSP 部分に相当する内蔵プラグイン `paraeq` を追加した
（UI はフェーズ3で別途。今回は既存の自動生成スライダーのみ）。

### 構成

- 7つの `BiquadFilterNode` を常時直列。再配線は一切しない。
- 各バンド 5 パラメータ × 7 バンド = 35 個: `onN`（0/1）/ `tyN`（0〜6 =
  bell / low-shelf / high-shelf / lowpass / highpass / notch / bandpass）/
  `fqN`（20〜20k）/ `gnN`（±18dB）/ `qN`（0.1〜10）。ラベルは「B1型」「B1周波」等で簡潔に。
- **バイパス = peaking + ゲイン 0dB**。peaking の 0dB は伝達関数が厳密に 1 なので、
  ノードを外さず（= 再配線クリックなしで）バンドを無効化できる。型切替は瞬時、
  周波数・ゲイン・Q のライブ変更は `setTargetAtTime`（時定数 0.01s）でなめす。
  bell バンドの on/off は型が変わらずゲインのフェードだけになる。
- 既定値は「挿した瞬間に音が変わらない」: B1=highpass 30Hz（無効）、B7=lowpass 18kHz（無効）、
  B2〜B6=bell 0dB（100/315/1k/3.15k/8kHz の log 配置）。
- 戻り値に `getFrequencyResponse(freqArray) → magArray` を追加
  （各 `BiquadFilter.getFrequencyResponse` の振幅の積。無効バンドは振幅 1 なので影響しない）。
  フェーズ3のスペクトラム表示 UI がこれを使う想定。
- ctx はライブ / オフライン両対応（`create(ctx, params)` 時は `.value` 直接代入なので
  オフライン書き出しは先頭サンプルから設定どおり・決定的）。

### 検証

`test/tests-paraeq.js` にグループ「[41] パラメトリックEQ」（Q.1〜Q.15）を追加。
既定値の素通し（サンプル最大差 <1e-4）/ bell +12dB の増幅と隣接帯域の不変 /
highpass の低域減衰と通過帯域の素通し / `getFrequencyResponse` 合成値と単体フィルタの積の一致 /
set() での型切替・on/off 後の出力有限性 / 決定性（2回レンダリングが同一サンプル）/
実トラックでの `exportMix` とライブ変更、をカバー。全スイート 1073/1073 pass を確認
（`PORT=8804 bash test/run.sh`、本体最新コード + 本プラグインの統合コピーで実行）。
