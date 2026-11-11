import os,sys
d=sys.argv[1]; r=lambda n:open(os.path.join(d,n)).read().strip()
def sz(n,w=None,h=None):
    s=r(n); a=(f' width="{w}"' if w else '')+(f' height="{h}"' if h else '')
    return s.replace('<svg ',f'<svg{a} ',1)
html=f'''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kotono CMS ロゴ</title>
<style>
:root{{--paper:#FBFAF7;--ink:#232A2E;--petrol:#0573AA;--p300:#85CDFF;--page:#F0EEEB;--muted:#5d6468;--line:#d9d6d0}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--page);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}}
main{{max-width:1040px;margin:0 auto;padding:32px 16px 64px}}
h1{{font-size:24px;margin:0 0 4px}} h2{{font-size:18px;margin:32px 0 12px}}
p,li{{color:var(--muted)}} code{{font-size:13px}}
.card{{border-radius:8px;padding:32px;display:flex;flex-wrap:wrap;gap:32px;align-items:center;border:1px solid var(--line)}}
.paper{{background:var(--paper)}} .dark{{background:var(--ink);border-color:var(--ink)}} .page{{background:var(--page)}}
.lbl{{font-size:12px;color:var(--muted);width:100%;margin:-16px 0 0}} .dark .lbl{{color:#c9ccce}}
svg{{max-width:100%;height:auto;display:block}}
.clear{{position:relative;display:inline-block;outline:1px dashed var(--petrol);padding:48px}}
.clear>svg{{outline:1px solid rgba(5,115,170,.35)}}
.px svg{{image-rendering:pixelated}}
table{{border-collapse:collapse;font-size:13px}} td,th{{padding:6px 12px;border-bottom:1px solid var(--line);text-align:left}}
.sw{{display:inline-block;width:16px;height:16px;border-radius:4px;vertical-align:middle;border:1px solid var(--line)}}
</style></head><body><main>
<h1>Kotono CMS ロゴ</h1>
<p>デザインシステム 0.4.0 のブランド色と 4px グリッドに合わせたアプリアイコンとロゴタイプ。シンボルは 24 単位の正方格子で一から作図（縦棒 7.5、すき間 2、腕の角度 25°、腕の太さ 7、角丸 1.5）。文字は Inter（可変フォントの太さ 740、表示用の字形 opsz 32）をアウトライン化した図形で、フォントの導入は不要。</p>

<h2>ロゴタイプ</h2>
<div class="card paper"><p class="lbl">カラー（kotono-logotype.svg）</p>{sz('kotono-logotype.svg',h=96)}</div>
<div class="card dark" style="margin-top:12px"><p class="lbl">ダーク背景用カラー（kotono-logotype-dark.svg）</p>{sz('kotono-logotype-dark.svg',h=96)}</div>
<div class="card paper" style="margin-top:12px"><p class="lbl">モノクロ（kotono-logotype-mono.svg）</p>{sz('kotono-logotype-mono.svg',h=64)}</div>
<div class="card dark" style="margin-top:12px"><p class="lbl">反転（kotono-logotype-reversed.svg）</p>{sz('kotono-logotype-reversed.svg',h=64)}</div>
<div class="card paper" style="margin-top:12px"><p class="lbl">縮小（高さ 48／32／20px）</p>{sz('kotono-logotype.svg',h=48)}{sz('kotono-logotype.svg',h=32)}{sz('kotono-logotype.svg',h=20)}</div>

<h2>アプリアイコン</h2>
<div class="card page"><p class="lbl">kotono-icon.svg／kotono-icon-mono.svg／kotono-mark.svg</p>{sz('kotono-icon.svg',192)}{sz('kotono-icon-mono.svg',128)}{sz('kotono-mark.svg',h=96)}</div>
<div class="card page px" style="margin-top:12px"><p class="lbl">小サイズ用（左から 64px 通常、32px 専用版、16px 専用版。専用版は縦棒とすき間を画素の整数倍にしてある）</p>{sz('kotono-icon.svg',64)}{sz('kotono-icon-32.svg',32)}{sz('kotono-icon-16.svg',16)}<span style="width:24px"></span>{sz('kotono-icon-32.svg',128)}{sz('kotono-icon-16.svg',128)}</div>

<h2>余白と寸法</h2>
<div class="card paper"><div class="clear">{sz('kotono-logotype.svg',h=96)}</div></div>
<ul>
<li>基準の大きさ（viewBox）は高さ 32。シンボルの高さ 32（<code>space-32</code>）、シンボルと文字の間 12（<code>space-12</code>）、大文字の高さ 22（上端 4、ベースライン 26）。シンボルは小文字の重心に合わせて、上に 4、下に 6 はみ出す。</li>
<li>周囲の余白はマークの高さの半分（基準の大きさで 16＝<code>space-16</code>）以上。上の破線がその範囲。</li>
<li>最小サイズ：ロゴタイプは高さ 20px。アイコンは 48px 以上で kotono-icon.svg、24〜47px で kotono-icon-32.svg、23px 以下で kotono-icon-16.svg。</li>
</ul>

<h2>色</h2>
<table><tr><th>用途</th><th>トークン</th><th>値</th></tr>
<tr><td>マーク・CMS・アイコン地</td><td><code>brand-petrol</code></td><td><span class="sw" style="background:#0573AA"></span> #0573AA</td></tr>
<tr><td>Kotono・モノクロ</td><td><code>brand-ink</code></td><td><span class="sw" style="background:#232A2E"></span> #232A2E</td></tr>
<tr><td>アイコンの K・反転</td><td><code>brand-paper</code></td><td><span class="sw" style="background:#FBFAF7"></span> #FBFAF7</td></tr>
<tr><td>ダーク背景のマーク・CMS</td><td><code>petrol-300</code>（ダークの accent）</td><td><span class="sw" style="background:#85CDFF"></span> #85CDFF</td></tr>
</table>

<h2>字詰め</h2>
<ul>
<li>Kotono と CMS は同じ大きさ・同じ太さ（740）。CMS は大文字用の字間（<code>cpsp</code>）を使用。</li>
<li>フォントのカーニング（K–o −81）に加え、表示サイズ向けに全体を −6／2048em 詰め、t の左右の空きを補正（o–t −24、t–o −8）、C の開口部ぶん C–M を −12。</li>
<li>Kotono と CMS の間は字面から字面まで 0.25em。</li>
</ul>
</main></body></html>'''
open(sys.argv[2],'w').write(html)
