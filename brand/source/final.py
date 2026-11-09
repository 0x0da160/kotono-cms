"""Kotono CMS logo generator. usage: python3 final.py OUTDIR
Needs fonttools + uharfbuzz and InterD-740.ttf (Inter 4.1 variable, instanced at wght 740 / opsz 32; see README)."""
import sys,os;sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import glyphs
glyphs.D=os.path.dirname(os.path.abspath(__file__))+'/'
from glyphs import *
from geom import *
from lockup import word
OUT=sys.argv[1]; os.makedirs(OUT,exist_ok=True)
PETROL,PAPER,INK,P300='#0573AA','#FBFAF7','#232A2E','#85CDFF'
MW=0.974  # mark width / height
def write(n,s): open(os.path.join(OUT,n),'w').write(s+'\n')
def head(w,h,t='Kotono CMS'): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" role="img" aria-label="{t}"><title>{t}</title>'
def rrect(S,r): return f'<rect width="{S}" height="{S}" rx="{fmt(r)}"'
# ---- app icon: mark = 60% of the tile, centred on its box; corner radius 0.1875 (as reference) ----
def icon(S,H,x0,y0,bg,fg,K=K3):
    return head(S,S)+rrect(S,S*0.1875)+f' fill="{bg}"/><path fill="{fg}" d="{kmark3_d(x0,y0,H,K)}"/></svg>'
H=512*0.60
write('kotono-icon.svg',icon(512,H,(512-MW*H)/2,(512-H)/2,PETROL,PAPER))
write('kotono-icon-mono.svg',icon(512,H,(512-MW*H)/2,(512-H)/2,INK,PAPER))
# small sizes: wider gaps so they survive at 1px, stem edges on the pixel grid
write('kotono-icon-32.svg',icon(32,20,6.25,6,PETROL,PAPER,k_small(0.035,0.03)))
write('kotono-icon-16.svg',icon(16,11,2.5,2.5,PETROL,PAPER,k_small(0.06,0.06)))
write('kotono-mark.svg',head(97.4,100)+f'<path fill="{PETROL}" d="{kmark3_d(0,0,100)}"/></svg>')
# ---- logotype on the 4px grid: mark 32 tall, cap height 20 (y 4..24), mark-to-text gap 10 ----
FN='InterD-740.ttf'
A=word(FN,'Kotono',{},-6,{'o|t':-24,'t|o':-8})
B=word(FN,'CMS',{'cpsp':True},0,{'C|M':-12})
f=A['f']; MH=32; CAP=20; fs=CAP*2048/f.cap; S=lambda u:u*fs/2048
base=24
tx=MW*MH+10-S(A['ink_l'])
dK=''.join(svgpath(f,g,tx+S(x),base,fs/2048) for g,x in A['gl'])
cx=tx+S(A['ink_r'])+0.25*fs-S(B['ink_l'])
dC=''.join(svgpath(B['f'],g,cx+S(x),base,fs/2048) for g,x in B['gl'])
LW=cx+S(B['ink_r']); dM=kmark3_d(0,0,MH)
print('logotype %.2f x %d, font %.2fpx'%(LW,MH,fs))
def logo(cm,ck,cc): return head(LW,MH)+f'<path fill="{cm}" d="{dM}"/><path fill="{ck}" d="{dK}"/><path fill="{cc}" d="{dC}"/></svg>'
write('kotono-logotype.svg',logo(PETROL,INK,PETROL))
write('kotono-logotype-dark.svg',logo(P300,PAPER,P300))
write('kotono-logotype-mono.svg',logo(INK,INK,INK))
write('kotono-logotype-reversed.svg',logo(PAPER,PAPER,PAPER))
