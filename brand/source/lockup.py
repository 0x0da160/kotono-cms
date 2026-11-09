import sys,json,math;sys.path.insert(0,'.')
from glyphs import *
from geom import *
from build2 import M as M0, mark_d
M=dict(M0); M.update(yA=0.335,rt=0.035)
FONTS={}
def F(n):
    if n not in FONTS: FONTS[n]=Font(n)
    return FONTS[n]
def word(fontname,text,feats,track=0,adj={}):
    f=F(fontname); gl,w=f.shape(text,feats); out=[]; extra=0
    for i,(g,x,a) in enumerate(gl):
        if i>0:
            extra+=track+adj.get(gl[i-1][0]+'|'+g,0)
        out.append((g,x+extra))
    # visual bbox
    from fontTools.pens.boundsPen import BoundsPen
    bp=BoundsPen(f.gs); f.gs[gl[0][0]].draw(bp); lsb=bp.bounds[0]
    bp=BoundsPen(f.gs); f.gs[gl[-1][0]].draw(bp); rx=out[-1][1]+bp.bounds[2]
    return dict(f=f,gl=out,ink_l=out[0][1]+lsb,ink_r=rx)
def lockup(cfg):
    fs=cfg['size']   # px per em
    S=lambda u:u*fs/2048
    A=word(cfg['font'],'Kotono',{},cfg.get('track',0),cfg.get('adj',{}))
    B=word(cfg['cfont'],'CMS',{'cpsp':True},cfg.get('ctrack',0),cfg.get('cadj',{}))
    f=A['f']; cap=S(f.cap); xh=S(f.xh)
    H=cap*cfg['mratio']; W=M['R']*H
    pad=cfg.get('pad',0)
    base=pad+ H/2 + cfg.get('vc',0.5)*cap   # baseline y so that mark center = baseline - vc*cap
    mx=pad; my=base-cfg.get('vc',0.5)*cap-H/2
    tx=mx+W+H*cfg['gap']-S(A['ink_l'])
    parts=[]
    d=''.join(svgpath(f,g,tx+S(x),base,fs/2048) for g,x in A['gl'])
    cx=tx+S(A['ink_r'])+cfg['wgap']*fs - S(word(cfg['cfont'],'CMS',{'cpsp':True})['ink_l'])
    d2=''.join(svgpath(B['f'],g,cx+S(x),base,fs/2048) for g,x in B['gl'])
    right=cx+S(B['ink_r'])
    Wt=right+pad; Ht=H+2*pad
    return dict(mark=mark_d(M,mx,my,H),kotono=d,cms=d2,w=Wt,h=Ht)
def svg(L,c_mark,c_word,c_cms,bg=None,width=None):
    w=f'width="{width}" ' if width else ''
    b=f'<rect width="100%" height="100%" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" {w}viewBox="0 0 {fmt(L["w"])} {fmt(L["h"])}">{b}<path fill="{c_mark}" d="{L["mark"]}"/><path fill="{c_word}" d="{L["kotono"]}"/><path fill="{c_cms}" d="{L["cms"]}"/></svg>'
if __name__=='__main__':
    base=dict(font='InterDisplay-Bold.otf',cfont='InterDisplay-Bold.otf',size=200,mratio=1.55,gap=0.30,wgap=0.24,pad=30,vc=0.5)
    vs=json.loads(sys.argv[1])
    out=[]
    for v in vs:
        c=dict(base);c.update(v); L=lockup(c)
        out.append(svg(L,'#0573AA','#232A2E',c.get('cc','#0573AA'),'#FBFAF7',900))
    open('cmp.html','w').write('<div style="display:flex;flex-direction:column;gap:12px;padding:12px">'+''.join(out)+'</div>')
