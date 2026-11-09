import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.basePen import BasePen
D='/usr/share/fonts/opentype/inter/'
class Font:
    def __init__(s,name):
        s.path=D+name; s.tt=TTFont(s.path); s.gs=s.tt.getGlyphSet()
        s.hbf=hb.Font(hb.Face(hb.Blob.from_file_path(s.path)))
        s.upm=s.tt['head'].unitsPerEm; s.cap=s.tt['OS/2'].sCapHeight; s.xh=s.tt['OS/2'].sxHeight
        s.order=s.tt.getGlyphOrder()
    def shape(s,text,feats=None):
        b=hb.Buffer(); b.add_str(text); b.guess_segment_properties()
        hb.shape(s.hbf,b,feats or {})
        out=[];x=0
        for i,p in zip(b.glyph_infos,b.glyph_positions):
            out.append((s.order[i.codepoint],x+p.x_offset,p.x_advance)); x+=p.x_advance
        return out,x
class Flat(BasePen):
    def __init__(s,gs):
        super().__init__(gs); s.polys=[]; s.cur=[]
    def _moveTo(s,p): s.cur=[p]
    def _lineTo(s,p): s.cur.append(p)
    def _curveToOne(s,a,b,c):
        p0=s.cur[-1]
        for i in range(1,17):
            t=i/16;mt=1-t
            s.cur.append((mt**3*p0[0]+3*mt*mt*t*a[0]+3*mt*t*t*b[0]+t**3*c[0],mt**3*p0[1]+3*mt*mt*t*a[1]+3*mt*t*t*b[1]+t**3*c[1]))
    def _qCurveToOne(s,a,b):
        p0=s.cur[-1]
        for i in range(1,17):
            t=i/16;mt=1-t
            s.cur.append((mt*mt*p0[0]+2*mt*t*a[0]+t*t*b[0],mt*mt*p0[1]+2*mt*t*a[1]+t*t*b[1]))
    def _closePath(s):
        if s.cur: s.polys.append(s.cur); s.cur=[]
    _endPath=_closePath
def polys(font,g):
    p=Flat(font.gs); font.gs[g].draw(p); return p.polys
def profile(ps,y):
    xs=[]
    for poly in ps:
        n=len(poly)
        for i in range(n):
            (x1,y1),(x2,y2)=poly[i],poly[(i+1)%n]
            if (y1<=y<y2) or (y2<=y<y1):
                xs.append(x1+(y-y1)*(x2-x1)/(y2-y1))
    return (min(xs),max(xs)) if xs else None
def svgpath(font,g,dx,dy,scale):
    pen=SVGPathPen(font.gs,ntos=lambda v:('%.2f'%v).rstrip('0').rstrip('.'))
    tp=TransformPen(pen,(scale,0,0,-scale,dx,dy)); font.gs[g].draw(tp); return pen.getCommands()
