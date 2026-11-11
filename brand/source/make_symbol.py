"""g2_segs.json -> symbol_trace.json (SVG path data in reference px + bbox), used by final2.py"""
import json, numpy as np, os
H=os.path.dirname(os.path.abspath(__file__))
S=json.load(open(os.path.join(H,'g2_segs.json')))
parts=[]; allp=[]
for shape in S:
    segs=np.array(shape)
    d=f"M{segs[0,0,0]:.3f} {segs[0,0,1]:.3f}"
    for s in segs: d+="C"+" ".join(f"{x:.3f} {y:.3f}" for x,y in s[1:])
    parts.append(d+"Z"); allp.append(segs.reshape(-1,2))
P=np.concatenate(allp); x0,y0=P.min(0); x1,y1=P.max(0)
json.dump(dict(d="".join(parts),x0=float(x0),y0=float(y0),w=float(x1-x0),h=float(y1-y0)),open(os.path.join(H,'symbol_trace.json'),'w'))
print('ok')
