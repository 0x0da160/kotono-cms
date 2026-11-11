import numpy as np
def bez(ctrl,t):
    t=np.asarray(t)[:,None]; P0,P1,P2,P3=ctrl
    return (1-t)**3*P0+3*(1-t)**2*t*P1+3*(1-t)*t**2*P2+t**3*P3
def bez1(ctrl,t):
    t=np.asarray(t)[:,None]; P0,P1,P2,P3=ctrl
    return 3*(1-t)**2*(P1-P0)+6*(1-t)*t*(P2-P1)+3*t**2*(P3-P2)
def bez2(ctrl,t):
    t=np.asarray(t)[:,None]; P0,P1,P2,P3=ctrl
    return 6*(1-t)*(P2-2*P1+P0)+6*t*(P3-2*P2+P1)
def chord_u(pts):
    d=np.r_[0,np.cumsum(np.linalg.norm(np.diff(pts,axis=0),axis=1))]
    return d/d[-1]
def gen_bezier(pts,u,t1,t2):
    p0,p3=pts[0],pts[-1]
    B0=(1-u)**3; B1=3*u*(1-u)**2; B2=3*u**2*(1-u); B3=u**3
    A1=(B1[:,None])*t1; A2=(B2[:,None])*t2
    C00=(A1*A1).sum(); C01=(A1*A2).sum(); C11=(A2*A2).sum()
    tmp=pts-(p0*(B0+B1)[:,None]+p3*(B2+B3)[:,None])
    X0=(A1*tmp).sum(); X1=(A2*tmp).sum()
    det=C00*C11-C01*C01
    seg=np.linalg.norm(p3-p0)
    if abs(det)<1e-12: al=seg/3; al_l=al_r=al
    else:
        al_l=(X0*C11-X1*C01)/det; al_r=(C00*X1-C01*X0)/det
        if al_l<1e-6*seg or al_r<1e-6*seg: al_l=al_r=seg/3
    return np.array([p0,p0+t1*al_l,p3+t2*al_r,p3])
def reparam(ctrl,pts,u):
    d=bez(ctrl,u)-pts; d1=bez1(ctrl,u); d2=bez2(ctrl,u)
    num=(d*d1).sum(1); den=(d1*d1).sum(1)+(d*d2).sum(1)
    with np.errstate(divide='ignore',invalid='ignore'):
        nu=u-np.where(np.abs(den)>1e-12,num/den,0)
    return np.clip(nu,0,1)
def max_err(ctrl,pts,u):
    d=((bez(ctrl,u)-pts)**2).sum(1)
    i=int(np.argmax(d[1:-1]))+1 if len(pts)>2 else 0
    return d[i],i
def fit_cubic(pts,t1,t2,err2):
    if len(pts)==2:
        dist=np.linalg.norm(pts[1]-pts[0])/3
        return [np.array([pts[0],pts[0]+t1*dist,pts[1]+t2*dist,pts[1]])]
    u=chord_u(pts)
    ctrl=gen_bezier(pts,u,t1,t2)
    e,split=max_err(ctrl,pts,u)
    if e<err2: return [ctrl]
    if e<err2*16:
        for _ in range(12):
            u=reparam(ctrl,pts,u)
            ctrl=gen_bezier(pts,u,t1,t2)
            e,split=max_err(ctrl,pts,u)
            if e<err2: return [ctrl]
    tc=pts[split-1]-pts[split+1]; tc=tc/np.linalg.norm(tc)
    return fit_cubic(pts[:split+1],t1,tc,err2)+fit_cubic(pts[split:],-tc,t2,err2)
def fit_closed(p,tol,chunk=None,nsplit=6):
    """fit a closed polyline with C1 cubic Beziers; joins at every `chunk` samples"""
    n=len(p)
    tan=np.roll(p,-1,0)-np.roll(p,1,0); tan=tan/np.linalg.norm(tan,axis=1)[:,None]
    chunk=chunk or n//nsplit
    starts=list(range(0,n,chunk))
    segs=[]
    for a,s in enumerate(starts):
        e=starts[a+1] if a+1<len(starts) else n
        idx=np.arange(s,e+1)%n
        pts=p[idx]
        segs+=fit_cubic(pts,tan[s],-tan[e%n],tol**2)
    return segs
def path_d(segs,f=lambda v:v):
    out=[f"M{segs[0][0][0]:.3f} {segs[0][0][1]:.3f}"]
    for c in segs:
        out.append("C"+" ".join(f"{x:.3f} {y:.3f}" for x,y in c[1:]))
    return "".join(out)+"Z"
