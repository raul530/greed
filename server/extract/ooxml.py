import sys, zipfile
from xml.etree import ElementTree as ET
NS_S='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
NS_A='{http://schemas.openxmlformats.org/drawingml/2006/main}'

def xlsx_text(path):
    with zipfile.ZipFile(path) as z:
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(NS_S+'si'):
                shared.append(''.join(t.text or '' for t in si.iter(NS_S+'t')))
        rows=[]
        for name in sorted(n for n in z.namelist()
                           if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')):
            for row in ET.fromstring(z.read(name)).iter(NS_S+'row'):
                cells=[]
                for c in row.iter(NS_S+'c'):
                    t=c.get('t'); v=c.find(NS_S+'v'); istr=c.find(NS_S+'is')
                    if t=='s' and v is not None: cells.append(shared[int(v.text)])
                    elif t=='inlineStr' and istr is not None:
                        cells.append(''.join(x.text or '' for x in istr.iter(NS_S+'t')))
                    else: cells.append(v.text if v is not None else '')
                rows.append('\t'.join(cells))
        return '\n'.join(rows)

def pptx_text(path):
    with zipfile.ZipFile(path) as z:
        out=[]
        for name in sorted(n for n in z.namelist()
                           if n.startswith('ppt/slides/slide') and n.endswith('.xml')):
            out.append(''.join(t.text or '' for t in ET.fromstring(z.read(name)).iter(NS_A+'t')))
        return '\n\n'.join(out)

if __name__=='__main__':
    mode, path = sys.argv[1], sys.argv[2]
    sys.stdout.write(xlsx_text(path) if mode=='xlsx' else pptx_text(path))
