import sys,json,math;sys.path.insert(0,'.')
from geom import *
M=dict(sw=0.29,gs=0.05,R=0.97,yA=0.30,h=0.33,g=0.05,r=0.07,ra=0.03,rt=0.02)
def mark_d(M,x0,y0,H):
    st,up,lo=kmark2(M)
    T=lambda pts:[(x0+x*H,y0+y*H) for x,y in pts]
    r,ra,rt=M['r']*H,M['ra']*H,M['rt']*H
    d=rounded(T(st),r)+rounded(T(up),[ra,r,r,ra])
    d+=rounded(T(lo),[ra,r,r]+([rt,rt] if len(lo)==5 else [rt]))
    return d
def squircle(S,n=5.0,N=180,o=0):
    c=S/2; pts=[]
    for i in range(N):
        t=2*math.pi*i/N; ct,st=math.cos(t),math.sin(t)
        pts.append((o+c+c*math.copysign(abs(ct)**(2/n),ct),o+c+c*math.copysign(abs(st)**(2/n),st)))
    return 'M'+' L'.join('%s %s'%(fmt(x),fmt(y)) for x,y in pts)+'Z'
def icon(M,size=512,frac=0.58,bg='#0573AA',fg='#FBFAF7',shift=0.0):
    H=size*frac; W=M['R']*H
    x0=(size-W)/2+shift*H; y0=(size-H)/2
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}"><path fill="{bg}" d="{squircle(size)}"/><path fill="{fg}" d="{mark_d(M,x0,y0,H)}"/></svg>'
if __name__=='__main__':
    svgs=[]
    for p in sys.argv[1:]:
        m=dict(M);m.update(json.loads(p)); svgs.append(icon(m).replace('<svg','<svg width="300"'))
    open('cmp.html','w').write('<div style="display:flex;gap:20px;padding:20px">'+''.join(svgs)+'</div>')
