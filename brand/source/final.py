import sys,math,os;sys.path.insert(0,'.')
from glyphs import *
from geom import *
from build2 import mark_d, squircle
from lockup import word, M as MK
OUT=sys.argv[1]; os.makedirs(OUT,exist_ok=True)
PETROL,PAPER,INK,P300='#0573AA','#FBFAF7','#232A2E','#85CDFF'
M=dict(MK); SHIFT=0.02   # optical centring (centroid is 0.04H left of bbox centre)
def write(n,s): open(os.path.join(OUT,n),'w').write(s+'\n')
def head(w,h,title): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" role="img" aria-label="{title}"><title>{title}</title>'
# ---- app icon (512) ----
def icon(m,size,H,x0,y0,bg,fg,title='Kotono CMS'):
    return head(size,size,title)+f'<path fill="{bg}" d="{squircle(size,N=240)}"/><path fill="{fg}" d="{mark_d(m,x0,y0,H)}"/></svg>'
H=512*0.58; W=M['R']*H
write('kotono-icon.svg',icon(M,512,H,(512-W)/2+SHIFT*H,(512-H)/2,PETROL,PAPER))
write('kotono-icon-mono.svg',icon(M,512,H,(512-W)/2+SHIFT*H,(512-H)/2,INK,PAPER))
# ---- small sizes: pixel-snapped verticals, wider gaps, smaller radii ----
m32=dict(M,sw=5/20,gs=2/20,R=19/20,g=0.10,r=0.06,ra=0.03,rt=0.04)
write('kotono-icon-32.svg',icon(m32,32,20,7,6,PETROL,PAPER))
m16=dict(M,sw=3/12,gs=1/12,R=11/12,g=0.10,yA=0.33,h=0.34,r=0.04,ra=0.02,rt=0.03)
write('kotono-icon-16.svg',icon(m16,16,12,3,2,PETROL,PAPER))
# ---- bare mark ----
write('kotono-mark.svg',head(M['R'],1,'Kotono CMS').replace('viewBox="0 0 0.97 1"','viewBox="0 0 97 100"')+f'<path fill="{PETROL}" d="{mark_d(M,0,0,100)}"/></svg>')
# ---- logotype: 4px grid. mark height 32 (space-32), gap 8 (space-8), cap height 20 ----
FB,FS='InterDisplay-Bold.otf','InterDisplay-SemiBold.otf'
A=word(FB,'Kotono',{},-8,{'o|t':-28,'t|o':-8})
B=word(FS,'CMS',{'cpsp':True},0,{'C|M':-14})
f=A['f']; MH=32; CAP=20; fs=CAP*2048/f.cap; S=lambda u:u*fs/2048
base=MH/2+CAP/2
mw=M['R']*MH
tx=mw+8-S(A['ink_l'])
dK=''.join(svgpath(f,g,tx+S(x),base,fs/2048) for g,x in A['gl'])
cx=tx+S(A['ink_r'])+0.25*fs-S(B['ink_l'])
dC=''.join(svgpath(B['f'],g,cx+S(x),base,fs/2048) for g,x in B['gl'])
LW=cx+S(B['ink_r']); dM=mark_d(M,0,0,MH)
print('logotype',LW,'x',MH,'font px',fs,'word gap',0.25*fs)
def logo(cm,ck,cc,t='Kotono CMS'):
    return head(LW,MH,t)+f'<path fill="{cm}" d="{dM}"/><path fill="{ck}" d="{dK}"/><path fill="{cc}" d="{dC}"/></svg>'
write('kotono-logotype.svg',logo(PETROL,INK,PETROL))
write('kotono-logotype-dark.svg',logo(P300,PAPER,P300))
write('kotono-logotype-mono.svg',logo(INK,INK,INK))
write('kotono-logotype-reversed.svg',logo(PAPER,PAPER,PAPER))
