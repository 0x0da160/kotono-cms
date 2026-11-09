"""Kotono CMS logo generator. usage: python3 final.py OUTDIR
Needs fonttools + uharfbuzz and InterD-740.ttf next to this file
(Inter 4.1 variable instanced at wght 740 / opsz 32; see brand/README.md)."""
import sys,os;sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import glyphs
glyphs.D=os.path.dirname(os.path.abspath(__file__))+'/'
from glyphs import *
from geom import fmt
from lockup import word
from newk import k_d, centroid
OUT=sys.argv[1]; os.makedirs(OUT,exist_ok=True)
PETROL,PAPER,INK,P300='#0573AA','#FBFAF7','#232A2E','#85CDFF'
# The symbol, on a 24-unit square: stem 7.5, gap 2, arms at 25 deg, arm thickness 7 (perpendicular), corner radius 1.5
K=dict(deg=25,t=7,r=1.5,sw=7.5,gap=2)
def write(n,s): open(os.path.join(OUT,n),'w').write(s+'\n')
def head(w,h,t='Kotono CMS',y0=0): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {fmt(y0)} {fmt(w)} {fmt(h)}" role="img" aria-label="{t}"><title>{t}</title>'
# ---- app icon: 512 tile, corner radius 112, symbol 288 (= 24 units x 12) ----
def icon(S,H,x0,y0,bg,fg,k):
    return head(S,S)+f'<rect width="{S}" height="{S}" rx="{fmt(S*112/512)}" fill="{bg}"/><path fill="{fg}" d="{k_d(x0,y0,H,**k)}"/></svg>'
H=288; shift=(12-centroid(**K))/24*H*0.5   # half-way between box centre and centroid
write('kotono-icon.svg',icon(512,H,(512-H)/2+shift,(512-H)/2,PETROL,PAPER,K))
write('kotono-icon-mono.svg',icon(512,H,(512-H)/2+shift,(512-H)/2,INK,PAPER,K))
# small sizes: stem and gaps land on whole pixels
write('kotono-icon-32.svg',icon(32,18,7,7,PETROL,PAPER,dict(K,sw=8,gap=8/3,t=7.33,r=1.33)))
write('kotono-icon-16.svg',icon(16,10,3,3,PETROL,PAPER,dict(K,sw=7.2,gap=2.4,t=7.2,r=1.2)))
write('kotono-mark.svg',head(24,24)+f'<path fill="{PETROL}" d="{k_d(0,0,24,**K)}"/></svg>')
# ---- logotype: symbol 32 (space-32), cap height 22 (top 4, baseline 26), symbol-to-text 12 (space-12) ----
FN='InterD-740.ttf'
A=word(FN,'Kotono',{},-6,{'o|t':-24,'t|o':-8})
B=word(FN,'CMS',{'cpsp':True},0,{'C|M':-12})
f=A['f']; MH=32; CAP=22; base=26; fs=CAP*2048/f.cap; S=lambda u:u*fs/2048
tx=MH+12-S(A['ink_l'])
dK=''.join(svgpath(f,g,tx+S(x),base,fs/2048) for g,x in A['gl'])
cx=tx+S(A['ink_r'])+0.25*fs-S(B['ink_l'])
dC=''.join(svgpath(B['f'],g,cx+S(x),base,fs/2048) for g,x in B['gl'])
LW=cx+S(B['ink_r']); dM=k_d(0,0,MH,**K)
print('logotype %.2f x %d, font %.2fpx'%(LW,MH,fs))
def logo(cm,ck,cc): return head(LW,MH)+f'<path fill="{cm}" d="{dM}"/><path fill="{ck}" d="{dK}"/><path fill="{cc}" d="{dC}"/></svg>'
write('kotono-logotype.svg',logo(PETROL,INK,PETROL))
write('kotono-logotype-dark.svg',logo(P300,PAPER,P300))
write('kotono-logotype-mono.svg',logo(INK,INK,INK))
write('kotono-logotype-reversed.svg',logo(PAPER,PAPER,PAPER))
