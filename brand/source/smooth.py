import numpy as np, json, sys
import os
C=np.load(os.path.join(os.path.dirname(os.path.abspath(__file__)),'contours.npy'),allow_pickle=True)

def resample_closed(p, step):
    p=np.asarray(p,float)
    if np.allclose(p[0],p[-1]): p=p[:-1]
    q=np.vstack([p,p[:1]])
    d=np.r_[0,np.cumsum(np.linalg.norm(np.diff(q,axis=0),axis=1))]
    L=d[-1]; n=int(round(L/step))
    s=np.linspace(0,L,n,endpoint=False)
    x=np.interp(s,d,q[:,0]); y=np.interp(s,d,q[:,1])
    return np.stack([x,y],1)

def fair(p, lam):
    """solve (I + lam * D^T D) x = p0 on a closed polyline; D = second difference"""
    n=len(p)
    D=np.zeros((n,n))
    idx=np.arange(n)
    D[idx,idx]=-2; D[idx,(idx+1)%n]=1; D[idx,(idx-1)%n]=1
    A=np.eye(n)+lam*D.T@D
    return np.linalg.solve(A,p)

def curvature(p):
    n=len(p)
    a=p-np.roll(p,1,axis=0); b=np.roll(p,-1,axis=0)-p
    cross=a[:,0]*b[:,1]-a[:,1]*b[:,0]
    la=np.linalg.norm(a,axis=1); lb=np.linalg.norm(b,axis=1)
    return 2*cross/(la*lb*np.linalg.norm(b+a,axis=1)+1e-12)

if __name__=='__main__':
    step=0.15
    for i,c in enumerate(C):
        p=resample_closed(c,step)
        k0=curvature(p)
        for lam in [0.5,2,8,30]:
            q=fair(p,lam)
            dev=np.linalg.norm(q-p,axis=1)
            k=curvature(q)
            # roughness: mean abs second difference of curvature (noise indicator)
            rough=np.abs(np.diff(k,2)).mean()
            print(f'shape {i} lam {lam}: max dev {dev.max():.3f} mean {dev.mean():.3f} | curv raw rough {np.abs(np.diff(k0,2)).mean():.3f} -> {rough:.3f}  kmax {np.abs(k).max():.2f}')
