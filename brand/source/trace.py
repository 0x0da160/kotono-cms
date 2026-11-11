import numpy as np, potrace
from PIL import Image, ImageFilter
SRC='/root/.claude/uploads/678546a3-a723-5c03-a13e-57e3035f5c70/fd27a138-IMG_4950.png'
im=Image.open(SRC).convert('RGB')
# crop around the white K (bbox ~238-426 x, 196-389 y), with margin
box=(222,180,442,406)
c=im.crop(box)
S=8
big=c.resize((c.width*S,c.height*S),Image.LANCZOS)
a=np.asarray(big).astype(float)
# signal: white K (high R) vs blue tile (low R); midpoint of paper and petrol red channel
paper=np.array([251,250,247.]); petrol=np.array([5,115,170.])
t=((a-petrol)@(paper-petrol))/((paper-petrol)@(paper-petrol))
mask=t>0.5
Image.fromarray((mask*255).astype('uint8')).save('mask_big.png')
bm=potrace.Bitmap(mask)
path=bm.trace(turdsize=20, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY, alphamax=1.0, opticurve=True, opttolerance=0.2)
ox,oy=box[0],box[1]
out=[]
for curve in path:
    sx,sy=curve.start_point.x,curve.start_point.y
    d=f"M{(sx/S+ox):.3f} {(sy/S+oy):.3f}"
    for seg in curve.segments:
        if seg.is_corner:
            cx,cy=seg.c.x,seg.c.y; ex,ey=seg.end_point.x,seg.end_point.y
            d+=f"L{cx/S+ox:.3f} {cy/S+oy:.3f}L{ex/S+ox:.3f} {ey/S+oy:.3f}"
        else:
            c1x,c1y=seg.c1.x,seg.c1.y; c2x,c2y=seg.c2.x,seg.c2.y; ex,ey=seg.end_point.x,seg.end_point.y
            d+=f"C{c1x/S+ox:.3f} {c1y/S+oy:.3f} {c2x/S+ox:.3f} {c2y/S+oy:.3f} {ex/S+ox:.3f} {ey/S+oy:.3f}"
    out.append(d+'Z')
D=''.join(out)
open('symbol_raw.txt','w').write(D)
print('subpaths',len(out),'chars',len(D))
