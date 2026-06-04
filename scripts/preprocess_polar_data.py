#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Polar 心拍数・加速度CSV 前処理スクリプト

目的:
- Polarの「加速度.csv」と「心拍数.csv」を、センサID・計測日ごとに対応付ける
- 加速度3軸から加速度ノルムを計算する
- 加速度ノルムを1秒区間平均にダウンサンプリングする
- 心拍数も1秒単位に整形する
- 1つのCSVに Date, Timestamp, SensorID, HeartRate, AccNorm として統合する
- GitHub Pages用の data/index.json を自動生成する

想定入力構造:
input_root/
  2026_01_08/
    2026_01_08_1035_1150_001_加速度.csv
    2026_01_08_1035_1150_001_心拍数.csv
    2026_01_08_1035_1150_002_加速度.csv
    2026_01_08_1035_1150_002_心拍数.csv

出力構造:
output_root/
  2026_01_08/
    2026_01_08_001_merged.csv
    2026_01_08_002_merged.csv
  index.json

使い方:
  python preprocess_polar_data.py --input-dir "D:/polar_raw" --output-dir "D:/HR-and-ACC-dashboard/data"

引数を省略すると、フォルダ選択ダイアログが開きます。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd


# =========================
# 設定
# =========================

CSV_ENCODINGS = ("utf-8-sig", "utf-8", "cp932", "shift_jis")

ACC_KEYWORDS = ("加速度", "acc", "acceler")
HR_KEYWORDS = ("心拍数", "心拍", "heart rate", "heartrate", "heart", "hr")

DEFAULT_INDEX_PREFIX = "data"
# 1日内に複数時間帯のデータが含まれる場合、この範囲だけを出力します。
# 必要に応じてここを書き換えてください。
CROP_START_TIME = "10:40:00"
CROP_END_TIME = "11:50:00"


# =========================
# データ構造
# =========================

@dataclass
class FileMeta:
    path: Path
    file_type: str  # "acc" or "hr"
    date: Optional[str]
    sensor_id: str


@dataclass
class Pair:
    date: str
    sensor_id: str
    acc_path: Optional[Path] = None
    hr_path: Optional[Path] = None


@dataclass
class ProcessResult:
    date: str
    sensor_id: str
    output_path: Path
    raw_acc_rows: int
    acc_1s_rows: int
    raw_hr_rows: int
    hr_1s_rows: int
    merged_rows: int
    first_timestamp: str
    last_timestamp: str


# =========================
# ユーティリティ
# =========================

def choose_folder(title: str) -> Optional[Path]:
    """引数が省略された場合にフォルダ選択ダイアログを開く。"""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception:
        return None

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    folder = filedialog.askdirectory(title=title)
    root.destroy()

    return Path(folder) if folder else None


def read_csv_flexible(path: Path) -> pd.DataFrame:
    """UTF-8 / CP932 などを順に試してCSVを読む。"""
    last_error: Optional[Exception] = None

    for enc in CSV_ENCODINGS:
        try:
            return pd.read_csv(path, encoding=enc)
        except UnicodeDecodeError as exc:
            last_error = exc

    # 文字コード以外のエラーはここで再発生させる
    if last_error is not None:
        raise last_error

    return pd.read_csv(path)


def canonical_header(text: str) -> str:
    return re.sub(r"[\s_\-()\[\]（）]", "", str(text).strip().lower())


def find_column(df: pd.DataFrame, candidates: list[str]) -> str:
    """候補名に近い列名を探す。見つからなければ例外。"""
    columns = list(df.columns)
    canonical = [canonical_header(c) for c in columns]

    for cand in candidates:
        key = canonical_header(cand)
        for i, col_key in enumerate(canonical):
            if col_key == key:
                return columns[i]

    for cand in candidates:
        key = canonical_header(cand)
        for i, col_key in enumerate(canonical):
            if key in col_key or col_key in key:
                return columns[i]

    raise ValueError(f"必要な列が見つかりません。候補={candidates}, 実際の列={columns}")


def parse_datetime(series: pd.Series) -> pd.Series:
    """Timestamp列をdatetimeへ変換する。"""
    dt = pd.to_datetime(series, errors="coerce")

    # pandasがうまく読めなかった場合の追加処理
    if dt.notna().sum() == 0:
        text = series.astype(str).str.strip()
        dt = pd.to_datetime(
            text.str.replace("年", "-", regex=False)
                .str.replace("月", "-", regex=False)
                .str.replace("日", " ", regex=False)
                .str.replace("_", "-", regex=False),
            errors="coerce",
        )

    return dt


def normalize_date(year: str, month: str, day: str) -> str:
    return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"


def find_date_in_text(text: str) -> Optional[str]:
    """ファイル名やフォルダ名から YYYY-MM-DD を抽出する。"""
    patterns = [
        r"(20\d{2})[\/_\-年](\d{1,2})[\/_\-月](\d{1,2})",
        r"(20\d{2})(\d{2})(\d{2})",
    ]

    for pat in patterns:
        m = re.search(pat, text)
        if m:
            return normalize_date(m.group(1), m.group(2), m.group(3))

    return None


def find_sensor_id(filename: str) -> str:
    """
    ファイル名からセンサIDを抽出する。
    例:
      2026_01_08_1035_1150_001_加速度.csv -> 001
      2026_01_08_1035_1150_V001_心拍数.csv -> V001
    """
    stem = Path(filename).stem

    stripped = re.sub(
        r"加速度|心拍数|心拍|Heart Rate|HeartRate|Heart|HR|ACC|Acceleration",
        "",
        stem,
        flags=re.IGNORECASE,
    )

    tokens = re.split(r"[_\-\s]+", stripped)
    tokens = [t for t in tokens if t]

    # 日付や時刻らしいトークンを除外し、最後に残ったIDらしいものを採用
    candidates: list[str] = []
    for tok in tokens:
        if re.fullmatch(r"20\d{2}", tok):
            continue
        if re.fullmatch(r"\d{1,2}", tok):
            continue
        if re.fullmatch(r"\d{4}", tok):  # 1035, 1150 など
            continue
        if re.fullmatch(r"[A-Za-z]*\d{1,6}", tok):
            candidates.append(tok)

    if candidates:
        return candidates[-1]

    # fallback: ファイル名末尾の数値
    m = re.search(r"([A-Za-z]*\d{1,6})(?=[_\-\s]*(?:加速度|心拍|hr|acc|\.csv|$))", stem, flags=re.IGNORECASE)
    if m:
        return m.group(1)

    return "001"


def classify_file(path: Path) -> Optional[str]:
    text = str(path).lower()

    if any(k.lower() in text for k in ACC_KEYWORDS):
        return "acc"

    if any(k.lower() in text for k in HR_KEYWORDS):
        return "hr"

    return None


def parse_file_meta(path: Path, input_dir: Path) -> Optional[FileMeta]:
    file_type = classify_file(path)
    if file_type is None:
        return None

    rel_text = str(path.relative_to(input_dir)).replace("\\", "/")
    date = find_date_in_text(rel_text)
    sensor_id = find_sensor_id(path.name)

    return FileMeta(
        path=path,
        file_type=file_type,
        date=date,
        sensor_id=sensor_id,
    )


def safe_min_max_timestamp(df: pd.DataFrame) -> tuple[str, str]:
    if df.empty:
        return "", ""

    first = df["Timestamp"].iloc[0]
    last = df["Timestamp"].iloc[-1]

    return str(first), str(last)

def time_string_to_seconds(value: str) -> int:
    parts = [int(x) for x in str(value).split(":")]
    if len(parts) == 2:
        h, m = parts
        s = 0
    elif len(parts) == 3:
        h, m, s = parts
    else:
        raise ValueError(f"時刻形式が不正です: {value}")
    return h * 3600 + m * 60 + s


def filter_by_time_window(df: pd.DataFrame, start_time: str, end_time: str) -> pd.DataFrame:
    """Timestamp列を使い、指定した1日内時刻範囲だけを残す。"""
    if df.empty:
        return df
    start_sec = time_string_to_seconds(start_time)
    end_sec = time_string_to_seconds(end_time)
    if end_sec <= start_sec:
        raise ValueError("CROP_END_TIME は CROP_START_TIME より後にしてください。")
    ts = pd.to_datetime(df["Timestamp"], errors="coerce")
    sec = ts.dt.hour * 3600 + ts.dt.minute * 60 + ts.dt.second
    return df[(sec >= start_sec) & (sec <= end_sec)].copy()



# =========================
# 前処理
# =========================

def preprocess_acceleration(path: Path) -> tuple[pd.DataFrame, int]:
    """
    加速度CSVを読む。
    - Timestamp
    - ACC X
    - ACC Y
    - ACC Z

    出力:
    - Timestamp: 1秒にfloorした時刻
    - AccNorm: 1秒区間平均の加速度ノルム
    """
    df = read_csv_flexible(path)
    raw_rows = len(df)

    ts_col = find_column(df, ["Timestamp", "Time", "DateTime", "日時"])
    x_col = find_column(df, ["ACC X", "AccX", "Acceleration X", "X"])
    y_col = find_column(df, ["ACC Y", "AccY", "Acceleration Y", "Y"])
    z_col = find_column(df, ["ACC Z", "AccZ", "Acceleration Z", "Z"])

    out = pd.DataFrame()
    out["Timestamp"] = parse_datetime(df[ts_col])
    out["ACC_X"] = pd.to_numeric(df[x_col], errors="coerce")
    out["ACC_Y"] = pd.to_numeric(df[y_col], errors="coerce")
    out["ACC_Z"] = pd.to_numeric(df[z_col], errors="coerce")

    out = out.dropna(subset=["Timestamp", "ACC_X", "ACC_Y", "ACC_Z"]).copy()

    out["Timestamp"] = out["Timestamp"].dt.floor("s")
    out["AccNorm"] = np.sqrt(
        out["ACC_X"] * out["ACC_X"]
        + out["ACC_Y"] * out["ACC_Y"]
        + out["ACC_Z"] * out["ACC_Z"]
    )

    acc_1s = (
        out.groupby("Timestamp", as_index=False)["AccNorm"]
        .mean()
        .sort_values("Timestamp")
        .reset_index(drop=True)
    )

    return acc_1s, raw_rows


def preprocess_heart_rate(path: Path) -> tuple[pd.DataFrame, int]:
    """
    心拍CSVを読む。
    - Timestamp
    - Heart Rate

    出力:
    - Timestamp: 1秒にfloorした時刻
    - HeartRate: 1秒区間平均の心拍数
    """
    df = read_csv_flexible(path)
    raw_rows = len(df)

    ts_col = find_column(df, ["Timestamp", "Time", "DateTime", "日時"])
    hr_col = find_column(df, ["Heart Rate", "HeartRate", "HR", "心拍数", "心拍"])

    out = pd.DataFrame()
    out["Timestamp"] = parse_datetime(df[ts_col])
    out["HeartRate"] = pd.to_numeric(df[hr_col], errors="coerce")

    # 0 bpmは未検出・欠損相当として除外
    out = out.dropna(subset=["Timestamp", "HeartRate"]).copy()
    out = out[out["HeartRate"] > 0].copy()

    out["Timestamp"] = out["Timestamp"].dt.floor("s")

    hr_1s = (
        out.groupby("Timestamp", as_index=False)["HeartRate"]
        .mean()
        .sort_values("Timestamp")
        .reset_index(drop=True)
    )

    return hr_1s, raw_rows


def merge_measurement(pair: Pair, output_dir: Path, index_prefix: str) -> ProcessResult:
    if pair.acc_path is None:
        raise ValueError(f"加速度CSVがありません: date={pair.date}, sensor={pair.sensor_id}")

    if pair.hr_path is None:
        raise ValueError(f"心拍CSVがありません: date={pair.date}, sensor={pair.sensor_id}")

    acc_1s, raw_acc_rows = preprocess_acceleration(pair.acc_path)
    hr_1s, raw_hr_rows = preprocess_heart_rate(pair.hr_path)

    merged = pd.merge(hr_1s, acc_1s, on="Timestamp", how="outer")
    merged = merged.sort_values("Timestamp").reset_index(drop=True)

    merged.insert(0, "SensorID", pair.sensor_id)
    merged.insert(0, "Date", pair.date)

    # 表示・読み込みを安定させるため、秒単位文字列にする
    # 10:40-11:50など、コード上で指定した時刻範囲だけを切り出す
    merged = filter_by_time_window(merged, CROP_START_TIME, CROP_END_TIME)

    merged["Timestamp"] = pd.to_datetime(merged["Timestamp"], errors="coerce").dt.strftime("%Y-%m-%d %H:%M:%S")

    merged = merged[["Date", "Timestamp", "SensorID", "HeartRate", "AccNorm"]]

    date_folder = pair.date.replace("-", "_")
    out_folder = output_dir / date_folder
    out_folder.mkdir(parents=True, exist_ok=True)

    out_name = f"{date_folder}_{pair.sensor_id}_merged.csv"
    out_path = out_folder / out_name

    # GitHub Pagesで読みやすいUTF-8 BOMなし
    merged.to_csv(out_path, index=False, encoding="utf-8")

    first_ts, last_ts = safe_min_max_timestamp(merged)

    return ProcessResult(
        date=pair.date,
        sensor_id=pair.sensor_id,
        output_path=out_path,
        raw_acc_rows=raw_acc_rows,
        acc_1s_rows=len(acc_1s),
        raw_hr_rows=raw_hr_rows,
        hr_1s_rows=len(hr_1s),
        merged_rows=len(merged),
        first_timestamp=first_ts,
        last_timestamp=last_ts,
    )


# =========================
# index.json
# =========================

def build_index_json(output_dir: Path, results: list[ProcessResult], index_prefix: str) -> Path:
    files: list[str] = []

    for result in sorted(results, key=lambda r: (r.date, r.sensor_id)):
        rel = result.output_path.relative_to(output_dir).as_posix()
        if index_prefix:
            files.append(f"{index_prefix.rstrip('/')}/{rel}")
        else:
            files.append(rel)

    index = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "format": "merged_1s",
        "description": f"Date, Timestamp, SensorID, HeartRate, AccNorm / cropped {CROP_START_TIME}-{CROP_END_TIME}",
        "files": files,
    }

    out_path = output_dir / "index.json"
    out_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    return out_path


def write_report(output_dir: Path, results: list[ProcessResult], warnings: list[str]) -> None:
    report_path = output_dir / "preprocess_report.csv"
    report_df = pd.DataFrame([r.__dict__ for r in results])

    if not report_df.empty:
        report_df["output_path"] = report_df["output_path"].astype(str)
        report_df.to_csv(report_path, index=False, encoding="utf-8-sig")

    if warnings:
        warning_path = output_dir / "preprocess_warnings.txt"
        warning_path.write_text("\n".join(warnings), encoding="utf-8")


# =========================
# メイン処理
# =========================

def collect_pairs(input_dir: Path) -> tuple[list[Pair], list[str]]:
    warnings: list[str] = []
    pair_map: dict[tuple[str, str], Pair] = {}

    csv_files = sorted(input_dir.rglob("*.csv"))

    for path in csv_files:
        meta = parse_file_meta(path, input_dir)
        if meta is None:
            continue

        # 日付がファイル名・フォルダ名から取れない場合はCSV中のTimestampから後で推定する
        date = meta.date
        if date is None:
            try:
                df_head = read_csv_flexible(path).head(10)
                ts_col = find_column(df_head, ["Timestamp", "Time", "DateTime", "日時"])
                dt = parse_datetime(df_head[ts_col]).dropna()
                if not dt.empty:
                    date = dt.iloc[0].strftime("%Y-%m-%d")
            except Exception:
                date = None

        if date is None:
            warnings.append(f"日付を判定できないためスキップ: {path}")
            continue

        key = (date, meta.sensor_id)

        if key not in pair_map:
            pair_map[key] = Pair(date=date, sensor_id=meta.sensor_id)

        pair = pair_map[key]

        if meta.file_type == "acc":
            if pair.acc_path is not None:
                warnings.append(f"同一date/sensorの加速度CSVが複数あります。後のファイルを採用: {pair.acc_path} -> {path}")
            pair.acc_path = path

        elif meta.file_type == "hr":
            if pair.hr_path is not None:
                warnings.append(f"同一date/sensorの心拍CSVが複数あります。後のファイルを採用: {pair.hr_path} -> {path}")
            pair.hr_path = path

    pairs = sorted(pair_map.values(), key=lambda p: (p.date, p.sensor_id))

    for pair in pairs:
        if pair.acc_path is None:
            warnings.append(f"加速度CSVなし: date={pair.date}, sensor={pair.sensor_id}")
        if pair.hr_path is None:
            warnings.append(f"心拍CSVなし: date={pair.date}, sensor={pair.sensor_id}")

    # 統合できるものだけ返す
    usable_pairs = [p for p in pairs if p.acc_path is not None and p.hr_path is not None]

    return usable_pairs, warnings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Polarの加速度CSVと心拍CSVを、1秒区間平均の統合CSVへ前処理します。"
    )

    parser.add_argument(
        "--input-dir",
        type=str,
        default=None,
        help="入力データフォルダ。省略時はフォルダ選択ダイアログを表示します。",
    )

    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="出力データフォルダ。GitHub Pages用ならリポジトリ内の data フォルダを指定します。",
    )

    parser.add_argument(
        "--index-prefix",
        type=str,
        default=DEFAULT_INDEX_PREFIX,
        help="index.json内に書くパス接頭辞。GitHub Pagesのdataフォルダなら通常は data のまま。",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    input_dir = Path(args.input_dir).expanduser().resolve() if args.input_dir else choose_folder("入力データフォルダを選択")
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else choose_folder("出力データフォルダを選択")

    if input_dir is None or not input_dir.exists():
        print("入力データフォルダが指定されていません。", file=sys.stderr)
        return 1

    if output_dir is None:
        print("出力データフォルダが指定されていません。", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[INFO] input_dir : {input_dir}")
    print(f"[INFO] output_dir: {output_dir}")

    pairs, warnings = collect_pairs(input_dir)

    if not pairs:
        print("[ERROR] 加速度CSVと心拍CSVのペアが見つかりませんでした。", file=sys.stderr)
        for w in warnings:
            print(f"[WARN] {w}", file=sys.stderr)
        return 2

    print(f"[INFO] {len(pairs)} 件の測定ペアを処理します。")

    results: list[ProcessResult] = []

    for i, pair in enumerate(pairs, start=1):
        print(f"[INFO] ({i}/{len(pairs)}) date={pair.date}, sensor={pair.sensor_id}")

        try:
            result = merge_measurement(pair, output_dir, args.index_prefix)
            results.append(result)
            print(f"       -> {result.output_path}")
            print(f"          acc: {result.raw_acc_rows:,} rows -> {result.acc_1s_rows:,} sec")
            print(f"          hr : {result.raw_hr_rows:,} rows -> {result.hr_1s_rows:,} sec")
            print(f"          merged: {result.merged_rows:,} rows")

        except Exception as exc:
            msg = f"処理失敗: date={pair.date}, sensor={pair.sensor_id}, error={exc}"
            warnings.append(msg)
            print(f"[WARN] {msg}", file=sys.stderr)

    index_path = build_index_json(output_dir, results, args.index_prefix)
    write_report(output_dir, results, warnings)

    print(f"[INFO] index.json を作成しました: {index_path}")
    print(f"[INFO] 統合CSV作成数: {len(results)}")
    if warnings:
        print(f"[INFO] 警告数: {len(warnings)}。preprocess_warnings.txt を確認してください。")

    print("[DONE] 前処理が完了しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
