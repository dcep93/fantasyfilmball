from pathlib import Path
import io, json, re, time

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import requests
from bs4 import BeautifulSoup

OUT=Path(__file__).parent
CHART_OUT=OUT/'output'
UA={'User-Agent':'Mozilla/5.0 movie chart research (local analysis script)'}
BOM_URL='https://www.boxofficemojo.com/year/2025/?grossesOption=totalGrosses'
WIKIDATA_URL='https://query.wikidata.org/sparql'

MANUAL_LETTERBOXD_SLUGS={
    'Lilo & Stitch':'film/lilo-stitch-2025',
    "Five Nights at Freddy's 2":'film/five-nights-at-freddys-2',
    "Now You See Me: Now You Don't":'film/now-you-see-me-now-you-dont-2025',
    'Den of Thieves: Pantera':'film/den-of-thieves-2-pantera',
    "Gabby's Dollhouse: The Movie":'film/gabbys-dollhouse-the-movie',
    'M3GAN 2.0':'film/m3gan-20',
    'Good Boy':'film/good-boy-2025',
    'The Senior':'film/the-senior',
    'Brave the Dark':'film/brave-the-dark',
    'The Friend':'film/the-friend-2024',
    'Hell of a Summer':'film/hell-of-a-summer',
    'The Toxic Avenger':'film/the-toxic-avenger-2023',
    'Riff Raff':'film/riff-raff-2024',
}

def pct(vals,v):
    vals=np.array([x for x in vals if np.isfinite(x)])
    return np.nan if not np.isfinite(v) or len(vals)==0 else 100*(np.sum(vals<=v)-.5)/len(vals)

def money(v):
    if pd.isna(v):
        return np.nan
    s=str(v)
    if s=='-' or not s:
        return np.nan
    return float(re.sub(r'[^0-9.]','',s) or 'nan')

def norm_title(title):
    s=str(title).lower()
    s=s.replace('&','and')
    s=re.sub(r'(?i)(\d+)(st|nd|rd|th) anniversary','',s)
    s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()

def slugify(title):
    s=title.replace('&',' ')
    s=s.replace("'",'')
    s=s.replace('.','')
    s=re.sub(r'(?i)20th anniversary','',s)
    s=re.sub(r'[^A-Za-z0-9]+','-',s.lower())
    return re.sub(r'-+','-',s).strip('-')

def candidate_slugs(title):
    base=slugify(title)
    candidates=[base, f'{base}-2025']
    if base.startswith('the-'):
        candidates += [base[4:], f'{base[4:]}-2025']
    seen=set()
    return [c for c in candidates if c and not (c in seen or seen.add(c))]

def fetch_box_office_mojo():
    html=requests.get(BOM_URL,headers=UA,timeout=30).text
    df=pd.read_html(io.StringIO(html))[0]
    out=pd.DataFrame({
        'rank':df['Rank'],
        'title':df['Release'],
        'domestic_gross':df[('Total Gross' if 'Total Gross' in df.columns else 'Gross')].map(money),
        'boxoffice_open':df.get('Open'),
        'boxoffice_close':df.get('Close'),
        'distributor':df.get('Distributor'),
        'estimated':df.get('Estimated'),
    })
    return out

def fetch_wikidata():
    query='''
SELECT ?film ?filmLabel ?altLabel ?date ?budget ?boxOffice ?letterboxd WHERE {
  ?film wdt:P31/wdt:P279* wd:Q11424;
        wdt:P577 ?date.
  FILTER(?date >= "2024-01-01"^^xsd:dateTime && ?date < "2026-01-01"^^xsd:dateTime)
  OPTIONAL { ?film wdt:P2130 ?budget. }
  OPTIONAL { ?film wdt:P2142 ?boxOffice. }
  OPTIONAL { ?film wdt:P6127 ?letterboxd. }
  OPTIONAL { ?film skos:altLabel ?altLabel. FILTER(LANG(?altLabel)="en") }
  FILTER(BOUND(?budget) || BOUND(?boxOffice) || BOUND(?letterboxd))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
'''
    r=requests.get(WIKIDATA_URL,params={'query':query,'format':'json'},headers=UA,timeout=90)
    r.raise_for_status()
    records={}
    for item in r.json()['results']['bindings']:
        labels=[item.get('filmLabel',{}).get('value'),item.get('altLabel',{}).get('value')]
        rec={
            'wikidata_id':item.get('film',{}).get('value','').rsplit('/',1)[-1],
            'wikidata_title':item.get('filmLabel',{}).get('value'),
            'wikidata_release_date':item.get('date',{}).get('value'),
            'wikidata_budget':float(item['budget']['value']) if 'budget' in item else np.nan,
            'wikidata_box_office':float(item['boxOffice']['value']) if 'boxOffice' in item else np.nan,
            'wikidata_letterboxd_slug':item.get('letterboxd',{}).get('value'),
        }
        if np.isfinite(rec['wikidata_budget']) and rec['wikidata_budget']>500_000_000:
            rec['wikidata_budget']=np.nan
        for label in labels:
            if label:
                records.setdefault(norm_title(label),rec)
    return records

def expanded_data_from_sources(existing):
    bom=fetch_box_office_mojo()
    wikidata=fetch_wikidata()
    existing_by_title={norm_title(r.title):r for _,r in existing.iterrows()}
    rows=[]
    for _,row in bom.iterrows():
        key=norm_title(row.title)
        old=existing_by_title.get(key)
        wd=wikidata.get(key,{})
        rec=row.to_dict()
        budget=np.nan
        wikipedia_title=np.nan
        if old is not None:
            budget=old.get('budget',np.nan)
            wikipedia_title=old.get('wikipedia_title',np.nan)
        if pd.isna(budget) and np.isfinite(wd.get('wikidata_budget',np.nan)):
            budget=wd.get('wikidata_budget')
        if np.isfinite(budget) and budget>500_000_000:
            budget=np.nan
        rec.update({
            'budget':budget,
            'wikipedia_title':wikipedia_title,
            'wikidata_id':wd.get('wikidata_id'),
            'wikidata_title':wd.get('wikidata_title'),
            'wikidata_release_date':wd.get('wikidata_release_date'),
            'wikidata_box_office':wd.get('wikidata_box_office',np.nan),
            'wikidata_letterboxd_slug':wd.get('wikidata_letterboxd_slug'),
            'letterboxd_avg':old.get('letterboxd_avg',np.nan) if old is not None else np.nan,
            'letterboxd_ratings':old.get('letterboxd_ratings',np.nan) if old is not None else np.nan,
            'letterboxd_slug':old.get('letterboxd_slug',np.nan) if old is not None else np.nan,
        })
        if row.title in MANUAL_LETTERBOXD_SLUGS and rec['letterboxd_slug']!=MANUAL_LETTERBOXD_SLUGS[row.title]:
            rec['letterboxd_slug']=MANUAL_LETTERBOXD_SLUGS[row.title]
            rec['letterboxd_avg']=np.nan
            rec['letterboxd_ratings']=np.nan
        if pd.isna(rec['letterboxd_slug']) and wd.get('wikidata_letterboxd_slug'):
            rec['letterboxd_slug']='film/'+wd['wikidata_letterboxd_slug']
        rows.append(rec)
    return pd.DataFrame(rows)

def letterboxd_json(slug):
    r=requests.get(f'https://letterboxd.com/{slug}/',headers=UA,timeout=25)
    if r.status_code!=200:
        return None
    soup=BeautifulSoup(r.text,'html.parser')
    for script in soup.find_all('script',type='application/ld+json'):
        txt=script.string or ''
        txt=txt[txt.find('{'):txt.rfind('}')+1]
        try:
            js=json.loads(txt)
        except Exception:
            continue
        if isinstance(js,dict) and js.get('@type')=='Movie':
            return js
    return None

def letterboxd_years(js):
    years=[]
    for ev in js.get('releasedEvent') or []:
        m=re.search(r'\d{4}',str(ev.get('startDate','')))
        if m:
            years.append(int(m.group()))
    return years

def fetch_letterboxd(title,slug_hint=None):
    trusted_manual=False
    if title in MANUAL_LETTERBOXD_SLUGS:
        slugs=[MANUAL_LETTERBOXD_SLUGS[title]]
        trusted_manual=True
    elif isinstance(slug_hint,str) and slug_hint and slug_hint!='nan':
        slugs=[slug_hint if slug_hint.startswith('film/') else f'film/{slug_hint}']
    else:
        slugs=[f'film/{s}' for s in candidate_slugs(title)]
    matches=[]
    for slug in slugs:
        js=letterboxd_json(slug)
        if js:
            matches.append((slug,js))
        time.sleep(0.12)
    if not matches:
        return np.nan,np.nan,None
    chosen=None
    for slug,js in matches:
        if 2025 in letterboxd_years(js):
            chosen=(slug,js)
            break
    if not chosen:
        for slug,js in matches:
            if any(y in (2024,2025) for y in letterboxd_years(js)):
                chosen=(slug,js)
                break
    if not chosen and trusted_manual:
        chosen=matches[0]
    if not chosen:
        return np.nan,np.nan,None
    slug,js=chosen
    ar=js.get('aggregateRating') or {}
    return float(ar.get('ratingValue',np.nan)),float(ar.get('ratingCount',np.nan)),slug

def label_extremes(ax,sub,xcol,ycol,residuals,limit=30):
    picks=[]
    def add(frame):
        for i in frame.index:
            if i not in picks:
                picks.append(i)
    n=max(3,min(8,len(sub)//8))
    add(sub.nlargest(n,xcol))
    add(sub.nsmallest(max(3,n//2),xcol))
    add(sub.nlargest(n,ycol))
    add(sub.nsmallest(n,ycol))
    res=pd.Series(residuals,index=sub.index)
    add(sub.loc[res.nlargest(n).index])
    add(sub.loc[res.nsmallest(n).index])
    add(sub.loc[res.abs().nlargest(n).index])
    for offset,(idx,r) in enumerate(sub.loc[picks[:limit]].iterrows()):
        ax.annotate(
            r.title,
            (r[xcol],r[ycol]),
            fontsize=7,
            alpha=.86,
            xytext=(4+(offset%3)*2,4+((offset//3)%3)*3),
            textcoords='offset points',
            bbox={'boxstyle':'round,pad=0.12','fc':'white','ec':'none','alpha':.55},
        )

ATTRS={
    'budget':{'label':'Production budget (USD)','log':True},
    'domestic_gross':{'label':'Domestic gross (USD)','log':True},
    'letterboxd_ratings':{'label':'Number of Letterboxd ratings','log':True},
    'letterboxd_avg':{'label':'Letterboxd reported average rating','log':False},
}

PAIRS=[
    ('budget','domestic_gross'),
    ('budget','letterboxd_ratings'),
    ('budget','letterboxd_avg'),
    ('domestic_gross','letterboxd_ratings'),
    ('domestic_gross','letterboxd_avg'),
    ('letterboxd_ratings','letterboxd_avg'),
]

def transform(values,log_scale):
    values=np.asarray(values,dtype=float)
    return np.log10(values) if log_scale else values

def inv_transform(values,log_scale):
    values=np.asarray(values,dtype=float)
    return 10**values if log_scale else values

def term_label(power):
    if power==0:
        return ''
    if power==1:
        return 't'
    return f't^{power}'

def equation_text(coeffs,y_name,x_name,r2):
    degree=len(coeffs)-1
    pieces=[]
    for i,c in enumerate(coeffs):
        power=degree-i
        if abs(c)<5e-7:
            continue
        sign='+' if c>=0 else '-'
        term=term_label(power)
        mag=abs(c)
        body=f'{mag:.3g}{term}' if term else f'{mag:.3g}'
        if not pieces:
            pieces.append(body if c>=0 else f'-{body}')
        else:
            pieces.append(f' {sign} {body}')
    rhs=''.join(pieces) if pieces else '0'
    return f'{y_name} = {rhs}\nwhere t = {x_name}\nR^2 = {r2:.3f}'

def fit_curve(sub,xcol,ycol):
    xlog=ATTRS[xcol]['log']
    ylog=ATTRS[ycol]['log']
    tx=transform(sub[xcol].to_numpy(float),xlog)
    ty=transform(sub[ycol].to_numpy(float),ylog)
    degree=min(5,len(sub)-2)
    coeffs=np.polyfit(tx,ty,degree)
    pred=np.polyval(coeffs,tx)
    ss_res=float(np.sum((ty-pred)**2))
    ss_tot=float(np.sum((ty-np.mean(ty))**2))
    r2=np.nan if ss_tot==0 else 1-(ss_res/ss_tot)
    grid_t=np.linspace(tx.min(),tx.max(),500)
    grid_x=inv_transform(grid_t,xlog)
    grid_y=inv_transform(np.polyval(coeffs,grid_t),ylog)
    return coeffs,r2,grid_x,grid_y,ty-pred

def draw_pair_chart(data,xcol,ycol):
    sub=data[['title',xcol,ycol]].dropna()
    sub=sub[(sub[xcol]>0)&(sub[ycol]>0)]
    if len(sub)<8:
        return None
    coeffs,r2,curve_x,curve_y,residuals=fit_curve(sub,xcol,ycol)
    xlog=ATTRS[xcol]['log']
    ylog=ATTRS[ycol]['log']
    fig,ax=plt.subplots(figsize=(14.5,9))
    ax.scatter(sub[xcol],sub[ycol],s=35,alpha=.72)
    label_extremes(ax,sub,xcol,ycol,residuals,limit=34)
    ax.plot(curve_x,curve_y,lw=3,label='least-squares polynomial (up to 6 terms)')
    if xlog:
        ax.set_xscale('log')
    if ylog:
        ax.set_yscale('log')
    ax.set_xlabel(ATTRS[xcol]['label'] + (' (log scale)' if xlog else ''))
    ax.set_ylabel(ATTRS[ycol]['label'] + (' (log scale)' if ylog else ''))
    ax.set_title(f'2025 domestic releases: {ATTRS[ycol]["label"]} vs. {ATTRS[xcol]["label"]} (n={len(sub)} of {len(data)})')
    y_expr='log10(y)' if ylog else 'y'
    x_expr='log10(x)' if xlog else 'x'
    ax.text(
        .015,.02,
        equation_text(coeffs,y_expr,x_expr,r2),
        transform=ax.transAxes,
        fontsize=8.5,
        va='bottom',
        ha='left',
        bbox={'boxstyle':'round,pad=0.35','fc':'white','ec':'0.75','alpha':.88},
    )
    ax.legend(loc='upper left')
    fig.tight_layout()
    CHART_OUT.mkdir(exist_ok=True)
    path=CHART_OUT/f'{xcol}_vs_{ycol}.png'
    fig.savefig(path,dpi=180)
    plt.close(fig)
    return path

def draw_all_pair_charts(data):
    CHART_OUT.mkdir(exist_ok=True)
    for old in CHART_OUT.glob('*.png'):
        old.unlink()
    paths=[]
    for xcol,ycol in PAIRS:
        path=draw_pair_chart(data,xcol,ycol)
        if path:
            paths.append(path)
    return paths

def write_oscar_rankings(data):
    oscar_titles=['One Battle After Another','Bugonia','F1: The Movie','Frankenstein','Hamnet','Marty Supreme','The Secret Agent','Sentimental Value','Sinners','Train Dreams','Blue Moon','It Was Just an Accident','KPop Demon Hunters','Avatar: Fire and Ash','Elio','Arco']
    winners={'One Battle After Another','Sinners','Frankenstein','KPop Demon Hunters','Sentimental Value'}
    rows=[]
    for title in oscar_titles:
        m=data[data.title.str.lower()==title.lower()]
        rec=m.iloc[0].to_dict() if len(m) else {'title':title,'domestic_gross':np.nan,'budget':np.nan,'letterboxd_avg':np.nan,'letterboxd_ratings':np.nan,'letterboxd_slug':None}
        rec.update(
            oscar_status='winner' if title in winners else 'nominee',
            domestic_gross_percentile=pct(data.domestic_gross,rec['domestic_gross']),
            budget_percentile=pct(data.budget,rec['budget']),
            letterboxd_avg_percentile=pct(data.letterboxd_avg,rec['letterboxd_avg']),
            letterboxd_ratings_percentile=pct(data.letterboxd_ratings,rec['letterboxd_ratings']),
        )
        rows.append(rec)
    pd.DataFrame(rows).to_csv(OUT/'oscar_nominees_winners_rankings.csv',index=False)

def main():
    data=pd.read_csv(OUT/'movie_2025_data.csv')
    data=expanded_data_from_sources(data)
    for col in ['letterboxd_avg','letterboxd_ratings','letterboxd_slug']:
        if col not in data:
            data[col]=np.nan
    data['letterboxd_slug']=data['letterboxd_slug'].astype('object')
    for idx,row in data.iterrows():
        if pd.notna(row.get('letterboxd_avg')) and pd.notna(row.get('letterboxd_ratings')):
            continue
        avg,count,slug=fetch_letterboxd(row.title,row.get('letterboxd_slug'))
        data.loc[idx,'letterboxd_avg']=avg
        data.loc[idx,'letterboxd_ratings']=count
        data.loc[idx,'letterboxd_slug']=slug
        print(f'{idx+1:02d} {row.title}: {avg} {count} {slug}', flush=True)
        time.sleep(0.5)
    data.to_csv(OUT/'movie_2025_data.csv',index=False)
    draw_all_pair_charts(data)
    write_oscar_rankings(data)
    (OUT/'README.md').write_text(
        '# 2025 movie charts\n\n'
        "Generated artifacts for the requested analysis. `movie_2025_data.csv` contains the 200 rows exposed by Box Office Mojo's 2025 domestic-gross table, joined to cached Wikipedia infobox budget values and bulk Wikidata budget values where found, plus live Letterboxd reported average rating and rating-count values where a matching Letterboxd film page could be resolved.\n\n"
        'The four charted attributes are domestic gross, production budget, Letterboxd rating count, and Letterboxd reported average rating. `output/` contains one chart for each pair of attributes. Each chart has a single least-squares polynomial curve with up to 6 terms, reports the fitted equation in the transformed plotting space, and includes R^2. There is no median-splitting curve.\n\n'
        'Point labels are selected from extrema and largest curve residuals rather than labeling every point. Older rerelease/event rows without a distinct current Letterboxd film page are left blank rather than borrowing unrelated historical page data.\n'
    )

if __name__=='__main__':
    main()
