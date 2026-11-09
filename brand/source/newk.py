import math,sys,os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from geom import rounded, line_isect, fmt
def kpolys(G=24.0, sw=7.0, gap=2.0, t=6.5, deg=30.0, r=1.25, over=None):
    """Kotono K symbol, constructed on a GxG square (y down).
    stem: [0,sw]; arms start at L=sw+gap and end flush at x=G.
    arms: parallel bands at +/-deg with perpendicular thickness t,
    lower arm tucked under the upper with perpendicular gap 'gap'."""
    tn=math.tan(math.radians(deg)); cs=math.cos(math.radians(deg))
    L=sw+gap; R=G
    if over is None: over=0.6*r          # optical overshoot for the acute rounded tips
    vt=t/cs; vg=gap/cs
    # upper arm: top edge through (R,-over) slope -tn  (y = -over + tn*(R-x))
    yt=lambda x:-over+tn*(R-x)
    up=[(L,yt(L)),(R,yt(R)),(R,yt(R)+vt),(L,yt(L)+vt)]
    # lower arm: bottom edge through (R,G+over), slope +tn  (y = G+over - tn*(R-x))
    yb=lambda x:G+over-tn*(R-x)
    cut=lambda x:yt(x)+vt+vg          # parallel to upper arm's underside, offset by gap
    # tip: cut ∩ bottom edge ; top-left: cut ∩ top edge (yb-vt)
    xtip=(G+over-tn*R - (-over+tn*R+vt+vg))/(-2*tn); xtip=( ( -over+tn*R+vt+vg) - (G+over-tn*R) )/(2*tn)
    xtl=( ( -over+tn*R+vt+vg) - (G+over-tn*R-vt) )/(2*tn)
    xtip=max(xtip,L)
    lo=[(xtl,cut(xtl)),(R,yb(R)-vt),(R,yb(R)),(xtip,yb(xtip))]
    if xtip==L and cut(L)<yb(L): lo=[(xtl,cut(xtl)),(R,yb(R)-vt),(R,yb(R)),(L,yb(L)),(L,cut(L))]
    stem=[(0,0),(sw,0),(sw,G),(0,G)]
    return stem,up,lo,r
def k_d(x0,y0,size,**kw):
    stem,up,lo,r=kpolys(**kw); G=kw.get('G',24.0); s=size/G
    T=lambda p:[(x0+x*s,y0+y*s) for x,y in p]
    return ''.join(rounded(T(p),r*s) for p in (stem,up,lo))
def centroid(**kw):
    stem,up,lo,r=kpolys(**kw); A=cx=0
    for p in (stem,up,lo):
        a=c=0
        for i in range(len(p)):
            x1,y1=p[i];x2,y2=p[(i+1)%len(p)];k=x1*y2-x2*y1;a+=k;c+=(x1+x2)*k
        A+=a/2; cx+=c/6
    return cx/A
if __name__=='__main__':
    print(kpolys()); print('centroid x',centroid())
