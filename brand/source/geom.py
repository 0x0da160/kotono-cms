import math
def fmt(v): s=('%.3f'%v).rstrip('0').rstrip('.'); return '0' if s=='-0' else s
def rounded(pts,radii):
    """closed polygon -> SVG path with circular fillets (radius per vertex)"""
    n=len(pts); out=[]
    for i in range(n):
        p0,p1,p2=pts[i-1],pts[i],pts[(i+1)%n]; r=radii[i] if isinstance(radii,(list,tuple)) else radii
        v1=(p0[0]-p1[0],p0[1]-p1[1]); v2=(p2[0]-p1[0],p2[1]-p1[1])
        l1=math.hypot(*v1); l2=math.hypot(*v2)
        u1=(v1[0]/l1,v1[1]/l1); u2=(v2[0]/l2,v2[1]/l2)
        ang=math.acos(max(-1,min(1,u1[0]*u2[0]+u1[1]*u2[1])))
        if r<=0 or ang<1e-6:
            out.append(('P',p1)); continue
        d=r/math.tan(ang/2); d=min(d,l1*0.49,l2*0.49); r=d*math.tan(ang/2)
        a=(p1[0]+u1[0]*d,p1[1]+u1[1]*d); b=(p1[0]+u2[0]*d,p1[1]+u2[1]*d)
        cross=v1[0]*v2[1]-v1[1]*v2[0]
        sweep=1 if cross<0 else 0
        out.append(('A',a,b,r,sweep))
    s=[]
    first=out[0]; start=first[1] if first[0]=='P' else first[2]
    s.append('M%s %s'%(fmt(start[0]),fmt(start[1])))
    for o in out[1:]+[out[0]]:
        if o[0]=='P': s.append('L%s %s'%(fmt(o[1][0]),fmt(o[1][1])))
        else:
            s.append('L%s %s'%(fmt(o[1][0]),fmt(o[1][1])))
            s.append('A%s %s 0 0 %d %s %s'%(fmt(o[3]),fmt(o[3]),o[4],fmt(o[2][0]),fmt(o[2][1])))
    return ''.join(s)+'Z'
def line_isect(p,s1,q,s2):
    # y = p[1]+s1*(x-p[0]) ; y=q[1]+s2*(x-q[0])
    x=(q[1]-p[1]+s1*p[0]-s2*q[0])/(s1-s2); return (x,p[1]+s1*(x-p[0]))
def kmark(P):
    """K mark in unit box height 1; returns (stem+upper polygon, lower polygon, width)"""
    sw,R,yA,h,g=P['sw'],P['R'],P['yA'],P['h'],P['g']
    s=yA/(R-sw)  # slope magnitude
    up=[(0,0),(sw,0),(sw,yA),(R,0),(R,h),(sw,yA+h),(sw,1),(0,1)]
    # lower arm: bottom edge through (R,1) slope +s ; top edge through (R,1-h) slope +s
    gv=g*math.sqrt(1+s*s)
    cutp=(sw,yA+h+gv)
    tx=P.get('tx')
    if tx is None:
        sl=s
    else:
        tipx=sw+tx; tipy=cutp[1]-s*(tipx-sw); sl=(1-tipy)/(R-tipx)
    t_perp=h/math.sqrt(1+s*s); hl=t_perp*math.sqrt(1+sl*sl)*P.get('lw',1.0)
    tip=line_isect(cutp,-s,(R,1),sl)
    top=line_isect(cutp,-s,(R,1-hl),sl)
    lo=[tip,top,(R,1-hl),(R,1)]
    return up,lo,s
def kmark2(P):
    sw,gs,R,yA,h,g=P['sw'],P['gs'],P['R'],P['yA'],P['h'],P['g']
    L=sw+gs; s=yA/(R-L)
    stem=[(0,0),(sw,0),(sw,1),(0,1)]
    up=[(L,yA),(R,0),(R,h),(L,yA+h)]
    gv=g*math.sqrt(1+s*s)
    cut0=(L,yA+h+gv)             # cut line: y=cut0.y - s(x-L)
    bot0=(L,1-yA)                # bottom edge: y = 1-yA + s(x-L)
    topl=(L,1-yA-h)
    a=line_isect(cut0,-s,topl,s)
    if cut0[1] < bot0[1]-1e-6:
        lo=[a,(R,1-h),(R,1),bot0,cut0]
    else:
        tip=line_isect(cut0,-s,bot0,s); lo=[a,(R,1-h),(R,1),tip]
    return stem,up,lo
