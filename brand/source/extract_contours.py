"""Extract the three symbol outlines from the reference image (run first).
usage: python3 extract_contours.py REFERENCE.png OUT_DIR"""
import numpy as np, sys, os
from PIL import Image
from skimage import measure
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
box=(222,180,442,406); S=8
c=Image.open(src).convert('RGB').crop(box).resize((220*S,226*S),Image.LANCZOS)
a=np.asarray(c).astype(float)
paper=np.array([251,250,247.]); petrol=np.array([5,115,170.])
t=((a-petrol)@(paper-petrol))/((paper-petrol)@(paper-petrol))
cs=[k for k in measure.find_contours(t,0.5) if len(k)>200]
res=[np.stack([k[:,1]/S+box[0],k[:,0]/S+box[1]],1) for k in cs]
np.save(os.path.join(out,'contours.npy'), np.array(res,dtype=object), allow_pickle=True)
print('contours', [len(r) for r in res])
