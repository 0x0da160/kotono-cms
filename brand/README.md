# Kotono CMS ロゴ

デザインシステム 0.4.0 のブランド色（Petrol #0573AA／Ink #232A2E／Paper #FBFAF7、ダーク背景用に petrol-300 #85CDFF）と 4px グリッドに合わせたアプリアイコンとロゴタイプ。見本は `preview.html`。

| ファイル                       | 内容                                                |
| ------------------------------ | --------------------------------------------------- |
| `kotono-icon.svg`              | アプリアイコン（512、48px 以上）                    |
| `kotono-icon-32.svg`           | 24〜47px 用。縦の線を画素に合わせ、すき間を広げた版 |
| `kotono-icon-16.svg`           | 23px 以下（favicon）用                              |
| `kotono-icon-mono.svg`         | モノクロのアイコン                                  |
| `kotono-mark.svg`              | K マーク単体                                        |
| `kotono-logotype.svg`          | ロゴタイプ（明るい背景、カラー）                    |
| `kotono-logotype-dark.svg`     | ロゴタイプ（暗い背景、カラー）                      |
| `kotono-logotype-mono.svg`     | ロゴタイプ（モノクロ、Ink）                         |
| `kotono-logotype-reversed.svg` | ロゴタイプ（反転、Paper）                           |

- シンボルは参考画像をトレース（potrace、8倍に拡大してから抽出）して作ったパス。`source/trace.py` で輪郭を取り、`source/optall.mjs`（svgo）で最適化した。作図版（`source/newk.py`）は残してある。
- 文字は Inter（可変フォントの太さ 740、opsz 32）をアウトライン化した図形。Kotono と CMS は同じ大きさ・同じ太さ。フォントの導入は不要。
- ロゴタイプの基準寸法：シンボル高さ 32（space-32）、シンボルと文字の間 12（space-12）、大文字の高さ 22（上端 4、ベースライン 26）。周囲の余白はシンボル高さの半分（space-16）以上。
- 字詰め：フォントのカーニングに加え、全体 −6/2048em、o–t −24、t–o −8、C–M −12。Kotono と CMS の間は字面間 0.25em。

## 再生成

`source/final2.py` で生成し、`source/optall.mjs` で svgo に通している（fonttools と uharfbuzz が必要）。先に Inter 4.1 の `InterVariable.ttf` から太さ 740・opsz 32 の静的フォントを `source/InterD-740.ttf` として作る。

```sh
python3 -c "from fontTools.ttLib import TTFont; from fontTools.varLib import instancer; instancer.instantiateVariableFont(TTFont('InterVariable.ttf'), {'wght': 740, 'opsz': 32}).save('brand/source/InterD-740.ttf')"
```

```sh
cd brand/source && python3 final.py .. && python3 preview.py .. ../preview.html
```
