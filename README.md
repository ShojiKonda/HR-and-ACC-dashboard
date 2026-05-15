# Polar 心拍・3軸加速度ダッシュボード

Polarで生成される心拍数CSVと加速度CSVを読み込み、センサID別に心拍数、3軸加速度ノルム、クラス中央値、IQR帯、日間変化を可視化するGitHub Pages用の静的Webアプリです。

## ファイル構成

```text
polar-dashboard-github/
├── index.html
├── style.css
├── app.js
├── .nojekyll
├── README.md
├── data/
│   ├── index.json
│   └── README.md
├── scripts/
│   └── build-data-index.js
└── .github/
    └── workflows/
        └── update-data-index.yml
```

GitHub Pagesでは、このフォルダ内のファイルをリポジトリのルート、または `docs/` に置いてください。

## データ配置

`data/` の下に、計測日フォルダごとにCSVを配置します。

```text
data/
├── index.json
├── 2026_01_08/
│   ├── 2026_01_08_1035_1150_001_加速度.csv
│   ├── 2026_01_08_1035_1150_001_心拍数.csv
│   ├── 2026_01_08_1035_1150_002_加速度.csv
│   └── 2026_01_08_1035_1150_002_心拍数.csv
└── 2026_01_15/
    ├── 2026_01_15_1035_1150_001_加速度.csv
    └── 2026_01_15_1035_1150_001_心拍数.csv
```

## GitHub Pages上での自動読込

アプリは起動時に `data/index.json` を読み込み、そこに記載されたCSVを自動取得して再計算します。

```json
{
  "files": [
    "data/2026_01_08/2026_01_08_1035_1150_001_加速度.csv",
    "data/2026_01_08/2026_01_08_1035_1150_001_心拍数.csv"
  ]
}
```

## 日付フォルダをアップロードしたときの自動反映

このセットには GitHub Actions 用の `.github/workflows/update-data-index.yml` を含めています。

GitHub Actions が有効な場合、`data/` 以下にCSVをアップロードしてコミットすると、次の処理が自動で実行されます。

1. `scripts/build-data-index.js` が `data/` 以下のCSVを再検索
2. `data/index.json` を自動更新
3. 更新がある場合は `Update data index` というコミットを自動作成
4. GitHub Pagesでアプリを開くと、新しいCSVが自動読込され、全グラフが再計算

Actionsを使わない場合は、`data/index.json` の `files` にCSVパスを手動で追加してください。

## CSV列

### 加速度CSV

必須列:

- `Timestamp`
- `ACC X`
- `ACC Y`
- `ACC Z`

処理:

- `sqrt(ACC X^2 + ACC Y^2 + ACC Z^2)` で3軸加速度ノルムを計算
- 1秒単位に平均化して描画

### 心拍CSV

必須列:

- `Timestamp`
- `Heart Rate`

処理:

- `Heart Rate <= 0` は欠損扱いとして除外
- 1秒単位に平均化して描画

## 表示内容

### タブ1 計測日別個人データ

- 計測日選択
- センサID選択
- 心拍時系列
- 3軸加速度ノルム時系列
- クラス中央値とIQR帯の加速度時系列
- クラス中央値とIQR帯の心拍時系列
- 平均加速度ノルムと平均心拍数の散布図
- 背景散布点は日別に色分け

### タブ2 個人内の変化

- センサID選択
- 比較する計測日の選択
- 心拍時系列の日間比較
- 3軸加速度ノルム時系列の日間比較
- クラス中央値とIQR帯の日間比較
- 散布図上の個人内変化ベクトル

## 手動アップロード機能

アプリ画面上の「フォルダ読込」「CSV複数読込」も残しています。

GitHubに置いた `data/index.json` 由来のデータを読み込んだ後に、ブラウザ上で追加CSVを選ぶと、既存データに追加または更新され、全グラフが再計算されます。

同じ `計測日 + センサID` のデータを再アップロードした場合は、その測定データを更新します。心拍CSVのみ、または加速度CSVのみを後から追加した場合は、既存のもう一方のデータを保持します。

## GitHub Pages設定

1. GitHubリポジトリにこのファイル一式をアップロードします。
2. リポジトリの `Settings` を開きます。
3. `Pages` を開きます。
4. `Build and deployment` の source を `Deploy from a branch` にします。
5. Branchを `main`、folderを `/root` または `/docs` にします。
6. 表示されたURLにアクセスします。

## 注意

- GitHub Actionsの自動コミットを使うには、リポジトリの `Settings > Actions > General > Workflow permissions` で `Read and write permissions` が有効になっている必要があります。
- GitHub Web UIのファイルアップロードにはサイズ・ファイル数の制限があります。大量データの場合はGitクライアントでのアップロードを推奨します。
- センサIDのみで個人情報を含まない設計を前提にしていますが、公開リポジトリに置く場合はCSVに氏名・学籍番号などが含まれていないことを確認してください。
