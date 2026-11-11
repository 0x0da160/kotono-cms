"""Kotono CMS logo generator (traced symbol). usage: python3 final2.py OUTDIR
Symbol: traced from the reference image (potrace, 8x upsampled), then svgo-optimised.
Text: Inter 4.1 variable instanced at wght 740 / opsz 32, outlined with fontTools."""
import sys,os,re,json
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
import glyphs; glyphs.D=HERE+'/'
from glyphs import *
from geom import fmt
from lockup import word
OUT=sys.argv[1]; os.makedirs(OUT,exist_ok=True)
PETROL,PAPER,INK,P300='#0573AA','#FBFAF7','#232A2E','#85CDFF'
SYM=json.load(open(os.path.join(HERE,'symbol_trace.json')))  # {"d": "...", "x0","y0","w","h"} in reference px
def sym_d(height, ox, oy):
    """traced symbol scaled to given height, placed at (ox,oy) top-left"""
    s=height/SYM['h']; x0,y0=SYM['x0'],SYM['y0']
    toks=re.findall(r'[MCLZ]|-?\d+(?:\.\d+)?', SYM['d']); out=[]; cmd=None; j=0
    f=lambda v: ('%.2f'%v).rstrip('0').rstrip('.')
    while j<len(toks):
        t=toks[j]
        if t=='Z': out.append('Z'); j+=1; continue
        if t in ('M','C','L'): cmd=t; out.append(t); j+=1; continue
        n=6 if cmd=='C' else 2
        v=[float(x) for x in toks[j:j+n]]; j+=n
        pts=[f((v[2*q]-x0)*s+ox)+' '+f((v[2*q+1]-y0)*s+oy) for q in range(n//2)]
        out.append(' '.join(pts))
    return ''.join(out)
SYM_W=SYM['w']/SYM['h']          # width / height
def write(n,s): open(os.path.join(OUT,n),'w').write(s+'\n')
def head(w,h,t='Kotono CMS'): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" role="img" aria-label="{t}"><title>{t}</title>'
# ---- app icon: 512 tile, symbol 60% of tile height, bbox centred ----
def icon(S,H,fg,bg):
    W=H*SYM_W; ox=(S-W)/2; oy=(S-H)/2
    return head(S,S,'Kotono CMS app icon')+f'<rect width="{S}" height="{S}" rx="{fmt(S*0.22)}" fill="{bg}"/><path fill="{fg}" d="{sym_d(H,ox,oy)}"/></svg>'
write('kotono-icon.svg',icon(512,307.2,PAPER,PETROL))
write('kotono-icon-mono.svg',icon(512,307.2,PAPER,INK))
write('kotono-icon-32.svg',icon(32,19.2,PAPER,PETROL))
write('kotono-icon-16.svg',icon(16,9.6,PAPER,PETROL))
write('kotono-mark.svg',head(SYM_W*100,100,'Kotono symbol')+f'<path fill="{PETROL}" d="{sym_d(100,0,0)}"/></svg>')
# ---- logotype: symbol 32 tall at x 0; cap height 22 (top 4, baseline 26); symbol-to-text 12 ----
FN='InterD-740.ttf'
A=word(FN,'Kotono',{},-6,{'o|t':-42,'t|o':-44,'o|n':-14,'n|o':-22}); B=word(FN,'CMS',{'cpsp':True},0,{'C|M':-12})
f=A['f']; MH=32; CAP=24; base=28; fs=CAP*2048/f.cap; S=lambda u:u*fs/2048
tx=MH*SYM_W+10-S(A['ink_l'])
dK=''.join(svgpath(f,g,tx+S(x),base,fs/2048) for g,x in A['gl'])
cx=tx+S(A['ink_r'])+0.25*fs-S(B['ink_l'])
dC=''.join(svgpath(B['f'],g,cx+S(x),base,fs/2048) for g,x in B['gl'])
LW=cx+S(B['ink_r']); dM=sym_d(MH,0,0)
def logo(cm,ck,cc): return head(LW,MH)+f'<path fill="{cm}" d="{dM}"/><path fill="{ck}" d="{dK}"/><path fill="{cc}" d="{dC}"/></svg>'
write('kotono-logotype.svg',logo(PETROL,INK,PETROL))
write('kotono-logotype-dark.svg',logo(P300,PAPER,P300))
write('kotono-logotype-mono.svg',logo(INK,INK,INK))
write('kotono-logotype-reversed.svg',logo(PAPER,PAPER,PAPER))
print('ok logotype width %.2f'%LW)
