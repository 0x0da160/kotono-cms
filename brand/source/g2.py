import numpy as np, sys, json
sys.path.insert(0,'.')
from smooth import C, resample_closed, fair
from schneider import fit_closed, bez, bez1, bez2
from scipy.optimize import least_squares
from scipy.spatial import cKDTree
TOL=float(sys.argv[1]) if len(sys.argv)>1 else 0.15
WK=float(sys.argv[2]) if len(sys.argv)>2 else 3.0
def kappa0(P): 
    d1=P[1]-P[0]; d2=P[2]-P[1]
    return (2/3)*(d1[0]*d2[1]-d1[1]*d2[0])/(np.linalg.norm(d1)**3+1e-12)
def kappa1(P):
    d1=P[2]-P[1]; d2=P[3]-P[2]
    return (2/3)*(d1[0]*d2[1]-d1[1]*d2[0])/(np.linalg.norm(d2)**3+1e-12)
def build(theta, a, b, J, P):
    """theta: join tangent angles (J,), a,b: handle lengths per segment; P: join points (J,2)"""
    segs=[]
    for i in range(J):
        j=(i+1)%J
        P0=P[i]; P3=P[j]
        t0=np.array([np.cos(theta[i]),np.sin(theta[i])])
        t1=np.array([np.cos(theta[j]),np.sin(theta[j])])
        P1=P0+a[i]*t0; P2=P3-b[i]*t1
        segs.append(np.array([P0,P1,P2,P3]))
    return segs
def fit_shape(data, tol):
    segs=fit_closed(data,tol)
    J=len(segs)
    P=np.array([s[0] for s in segs])
    theta=np.array([np.arctan2(*(s[1]-s[0])[::-1]) for s in segs])
    a=np.array([np.linalg.norm(s[1]-s[0]) for s in segs])
    b=np.array([np.linalg.norm(s[3]-s[2]) for s in segs])
    # data -> (segment, u) mapping from dense samples
    dense=[];owner=[];us=[]
    for i,s in enumerate(segs):
        u=np.linspace(0,1,200); pts=bez(s,u)
        dense.append(pts); owner+= [i]*len(u); us.append(u)
    dense=np.concatenate(dense); owner=np.array(owner); us=np.concatenate(us)
    tree=cKDTree(dense)
    _,idx=tree.query(data)
    seg_of=owner[idx]; u_of=us[idx]
    return dict(P=P,theta=theta,a=a,b=b,J=J,seg_of=seg_of,u_of=u_of)
def residuals(x, st, data):
    J=st['J']; theta=x[:J]; a=x[J:2*J]; b=x[2*J:3*J]
    segs=build(theta,a,b,J,st['P'])
    R=[]
    segs_arr=np.array(segs)  # (J,4,2)
    seg_of=st['seg_of']; u=st['u_of']
    # evaluate each data point on its segment
    P0=segs_arr[seg_of,0]; P1=segs_arr[seg_of,1]; P2=segs_arr[seg_of,2]; P3=segs_arr[seg_of,3]
    uu=u[:,None]
    pt=(1-uu)**3*P0+3*(1-uu)**2*uu*P1+3*(1-uu)*uu**2*P2+uu**3*P3
    R.append((pt-data).ravel())
    # curvature continuity at joins
    kk=[]
    for i in range(J):
        j=(i+1)%J
        kk.append(kappa1(segs[i])-kappa0(segs[j]))
    R.append(WK*np.array(kk))
    # gentle regularisation on handle lengths (keeps spacing sane)
    R.append(0.02*np.r_[a,b])
    return np.concatenate(R)
def run(c, tol):
    p=resample_closed(c,0.15); q=fair(p,8)
    st=fit_shape(q,tol)
    x0=np.r_[st['theta'],st['a'],st['b']]
    f=lambda x: residuals(x,st,q)
    r0=f(x0)
    res=least_squares(f,x0,method='trf',x_scale='jac',max_nfev=60)
    # remap once and refine
    J=st['J']; theta=res.x[:J]; a=res.x[J:2*J]; b=res.x[2*J:3*J]
    segs=build(theta,a,b,J,st['P'])
    dense=np.concatenate([bez(s,np.linspace(0,1,300)) for s in segs])
    _,idx=cKDTree(dense).query(q)
    st['seg_of']=np.repeat(np.arange(J),300)[idx]; st['u_of']=np.tile(np.linspace(0,1,300),J)[idx]
    res2=least_squares(lambda x: residuals(x,st,q),res.x,method='trf',x_scale='jac',max_nfev=60)
    J=st['J']; theta=res2.x[:J]; a=res2.x[J:2*J]; b=res2.x[2*J:3*J]
    segs=build(theta,a,b,J,st['P'])
    return segs, q
if __name__=='__main__':
    out=[]
    for i,c in enumerate(C):
        segs,q=run(c,TOL)
        pts=np.concatenate([bez(s,np.linspace(0,1,400)) for s in segs])
        d1,_=cKDTree(pts).query(c); d2,_=cKDTree(c).query(pts)
        # curvature jumps after refinement
        jumps=[kappa1(segs[k])-kappa0(segs[(k+1)%len(segs)]) for k in range(len(segs))]
        print('shape',i,'segments',len(segs),'dev mean %.3f max %.3f'%(np.r_[d1,d2].mean(),np.r_[d1,d2].max()),'max |dk| %.3f'%np.max(np.abs(jumps)))
        out.append([s.tolist() for s in segs])
    json.dump(out,open('g2_segs.json','w'))
