#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GitHub Pages用 data/index.json 作成スクリプト

役割:
- data フォルダ全体を再帰的にスキャンする
- 統合CSV（通常 *_merged.csv）のみを一覧化する
- data/index.json を作成・上書きする

このスクリプトは preprocess_polar_data.py から独立しています。
新しい日付フォルダやCSVを追加した後、このスクリプトだけ実行すれば index.json を更新できます。

使い方:
python scripts/build_data_index.py --data-dir "C:/Users/.../HR-and-ACC-dashboard/data"
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ============================================================
# 設定
# ============================================================

# GitHub Pagesのアプリが読むCSVだけを対象にする
INCLUDE_PATTERN = "*_merged.csv"

# index.json内のパス接頭辞
# 例: data/2026_05_07/2026_05_07_V001_merged.csv
INDEX_PATH_PREFIX = "data"

# indexに含めないファイル名
EXCLUDE_FILENAMES = {
    "index.json",
    "preprocess_report.csv",
    "preprocess_warnings.txt",
    "README.md",
}


def choose_folder(title: str) -> Optional[Path]:
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


def should_include(path: Path, data_dir: Path, pattern: str) -> bool:
    if not path.is_file():
        return False

    if path.name in EXCLUDE_FILENAMES:
        return False

    if path.suffix.lower() != ".csv":
        return False

    # 通常は *_merged.csv のみを対象にする
    if pattern and not path.match(pattern):
        return False

    # 隠しフォルダや一時ファイルを除外
    rel_parts = path.relative_to(data_dir).parts
    if any(part.startswith(".") for part in rel_parts):
        return False

    return True


def build_index(data_dir: Path, output_path: Path, prefix: str, pattern: str) -> dict:
    files: list[str] = []

    for path in sorted(data_dir.rglob("*.csv")):
        if not should_include(path, data_dir, pattern):
            continue

        rel = path.relative_to(data_dir).as_posix()
        if prefix:
            files.append(f"{prefix.rstrip('/')}/{rel}")
        else:
            files.append(rel)

    index = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "format": "merged_1s",
        "description": "Date, Timestamp, SensorID, HeartRate, AccNorm",
        "includePattern": pattern,
        "files": files,
    }

    output_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return index


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="dataフォルダをスキャンして data/index.json を作成します。")
    parser.add_argument("--data-dir", type=str, default=None, help="GitHub Pages用の data フォルダ")
    parser.add_argument("--output", type=str, default=None, help="出力するindex.json。省略時は data-dir/index.json")
    parser.add_argument("--prefix", type=str, default=INDEX_PATH_PREFIX, help="index.json内のパス接頭辞。通常は data")
    parser.add_argument("--pattern", type=str, default=INCLUDE_PATTERN, help="対象CSVパターン。通常は *_merged.csv")
    parser.add_argument("--print-files", action="store_true", help="indexに含めたファイル一覧を表示")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else choose_folder("dataフォルダを選択")
    if data_dir is None or not data_dir.exists():
        print("dataフォルダが指定されていないか、存在しません。", file=sys.stderr)
        return 1

    output_path = Path(args.output).expanduser().resolve() if args.output else data_dir / "index.json"

    index = build_index(
        data_dir=data_dir,
        output_path=output_path,
        prefix=args.prefix,
        pattern=args.pattern,
    )

    print(f"[INFO] data_dir : {data_dir}")
    print(f"[INFO] output   : {output_path}")
    print(f"[INFO] files    : {len(index['files'])}")

    if args.print_files:
        for file in index["files"]:
            print(file)

    if not index["files"]:
        print("[WARN] index.json に登録されたCSVが0件です。dataフォルダとファイル名を確認してください。", file=sys.stderr)

    print("[DONE] index.json を作成しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
