import json, sys, glob, os
ge_dir, *pp_dirs = sys.argv[1:]
def jg(pat): return json.load(open(glob.glob(os.path.join(ge_dir, pat))[0]))
def pctval(values, p):  # GE: [[pct, ms], ...], emitted only where the value steps
    best = None
    for q, v in values:
        if q <= p + 1e-9: best = v
    return best
G = {}
run = jg('runs_RUN.json')['data']['execution']; ind = run['indicators']
req = jg('series_requests_run*')['sumSeries']
rr = {x['label']: x['count'] for x in req['groupedCounts']['requestAndResponse']}
G['Requests total'] = rr['requests']; G['Responses OK'] = rr['responses OK']; G['Responses KO'] = rr['responses KO']
G['Error ratio %'] = ind['errorRatio']; G['p95 response ms'] = ind['p95']
rt = req['percentileDistributions']['responseTime']['all']
G['p50 response ms'] = pctval(rt['values'], 50); G['p99 response ms'] = pctval(rt['values'], 99); G['mean response ms'] = rt['mean']
G['Status codes'] = {x['label']: x['count'] for x in req['groupedCounts']['req.gc.cd']}
G['Error kinds'] = len(req['groupedCounts']['req.gc.err'])
u = jg('series_users_run*')['sumSeries']['groupedCounts']
G['Users started'] = {x['label']: x['count'] for x in u['usr.gc.scn.+']}
G['Max concurrent users'] = ind['maxConcurrentVU']
c = jg('series_connections_run*')
cc = {x['label']: x['count'] for x in c['sumSeries']['groupedCounts']['connections']}
G['Connections opened/closed'] = f"{cc['open']}/{cc['closed']}"
bits = {x['label']: x['count'] for x in c['sumSeries']['groupedCounts']['bits']}
G['Bits sent/received (Mb)'] = f"{bits['sent']/1e6:.1f}/{bits['received']/1e6:.1f}"
G['Remotes'] = len(jg('remotes_run*'))
for k, name in [('tcpConnectDuration', 'TCP connect'), ('tlsHandshakeDuration', 'TLS handshake')]:
    d = c['sumSeries']['percentileDistributions'][k]['all']
    G[f'{name} p50/p95/p99/max ms'] = '/'.join(str(pctval(d['values'], p)) for p in (50, 95, 99, 100))
    G[f'{name} mean ms'] = d['mean']
G['TCP connect KO'] = sum(v for v in c['sumSeries']['distributions']['tcpConnectDuration']['ko'] if v) if isinstance(c['sumSeries']['distributions']['tcpConnectDuration']['ko'], list) else '?'
G['TCP states series'] = len(c['timeSeries']['groupedCounts']['tcp.gc.conn.tcpState'])
d = jg('series_dns_run*')['sumSeries']
dd = {x['label']: x['count'] for x in d['groupedCounts']['dns']}
G['DNS lookups ok/ko'] = f"{dd['responses OK']}/{dd['responses KO']}"
dr = d['percentileDistributions']['dnsResolutionDuration']['all']
G['DNS p50/p99/max ms'] = '/'.join(str(pctval(dr['values'], p)) for p in (50, 99, 100)); G['DNS mean ms'] = dr['mean']
inj = jg('series_injectors_run*'); ig = inj['sumSeries']['groupedCounts']
G['GC collectors'] = sorted(x['label'] for x in ig['inj.gc.gc.count'])
G['GC count total'] = sum(x['count'] for x in ig['inj.gc.gc.count'])
G['TCP events'] = {x['label']: x['count'] for x in ig['inj.gc.tcp.evt']}
G['TCP segments'] = {x['label']: x['count'] for x in ig['inj.gc.tcp.seg']}
ts = inj['timeSeries']['counts']
def mx(k): v = [x for x in ts.get(k, []) if x is not None]; return max(v) if v else None
G['Heap max MB'] = mx('inj.c.heap.max')
G['Heap used peak MB'] = mx('inj.c.heap.used')
G['CPU user+sys peak %'] = round(max((a or 0) + (b or 0) for a, b in zip(ts['inj.c.cpu.user'], ts['inj.c.cpu.sys'])), 1)
G['RAM used peak/total GB'] = f"{mx('inj.c.ram.current')/1024:.1f}/{mx('inj.c.ram.max')/1024:.1f}"
G['Duration s'] = round((run['injectEnd'] - run['injectStart']) / 1000)

def pp(dirn):
    j = lambda f: json.load(open(os.path.join(dirn, f)))
    P = {}
    r = j('run.json'); P['Duration s'] = round(r['activityMs'] / 1000)
    row = [x for x in j('run_stats.json')['stats'] if x['scope'] == 'run'][0]
    P['Requests total'] = row['count']; P['Responses OK'] = row['okCount']; P['Responses KO'] = row['koCount']
    P['Error ratio %'] = round(row['errorRate'] * 100, 2)
    P['p50 response ms'] = row['percentiles'].get('p50'); P['p95 response ms'] = row['percentiles'].get('p95'); P['p99 response ms'] = row['percentiles'].get('p99'); P['mean response ms'] = round(row['meanMs'])
    st = {}
    for b in j('run_agent_status.json')['buckets']:
        for k, v in b['counts'].items(): st[k] = st.get(k, 0) + v
    P['Status codes'] = dict(sorted(st.items()))
    P['Error kinds'] = len(j('run_errors.json')['errors'])
    us = j('run_users.json')['scenarios']
    P['Users started'] = {s['scenario']: sum(b['started'] for b in s['buckets']) for s in us}
    conc = {}
    for s in us:
        for b in s['buckets']: conc[b['startOffsetMs']] = conc.get(b['startOffsetMs'], 0) + b['maxConcurrent']
    P['Max concurrent users'] = max(conc.values())
    c = j('run_agent_connections.json'); sm = c['sums']
    P['Connections opened/closed'] = f"{sm['opened']}/{sm['closed']}"
    P['Bits sent/received (Mb)'] = f"{sm['bitsOut']/1e6:.1f}/{sm['bitsIn']/1e6:.1f}"
    P['Remotes'] = len(j('run_agent.json')['remotes'])
    def pv(rows, p):
        for q, v in rows:
            if abs(q - p) < 1e-9: return v
    for k, name in [('tcpConnect', 'TCP connect'), ('tlsHandshake', 'TLS handshake')]:
        p = c[k]['percentiles']
        P[f'{name} p50/p95/p99/max ms'] = '/'.join(str(pv(p['all'], q)) for q in (50, 95, 99, 100))
        P[f'{name} mean ms'] = round(p['meanMs']['all'])
    P['TCP connect KO'] = c['tcpConnect']['totals']['ko']
    P['TCP states series'] = 'null (not Linux)' if all(b['states'] is None for b in c['buckets']) else len([k for b in c['buckets'] if b['states'] for k in b['states']][:0]) or sorted({k for b in c['buckets'] if b['states'] for k in b['states']}).__len__()
    d = j('run_agent_dns.json'); P['DNS lookups ok/ko'] = f"{d['sums']['ok']}/{d['sums']['ko']}"
    dp = d['resolution']['percentiles']
    P['DNS p50/p99/max ms'] = '/'.join(str(pv(dp['all'], q)) for q in (50, 99, 100)); P['DNS mean ms'] = round(dp['meanMs']['all'], 2)
    inj = j('run_agent_injectors.json'); bs = inj['buckets']
    gcn = {}
    for b in bs:
        for k, v in (b['gcCount'] or {}).items(): gcn[k] = gcn.get(k, 0) + (v or 0)
    P['GC collectors'] = sorted(gcn); P['GC count total'] = sum(gcn.values())
    def tot(field):
        out = {}
        for b in bs:
            for k, v in (b[field] or {}).items():
                if isinstance(v, (int, float)): out[k] = out.get(k, 0) + v
        return out or 'null (not Linux)'
    P['TCP events'] = tot('tcpEvents'); P['TCP segments'] = tot('tcpSegments')
    def mx(f): v = [b[f] for b in bs if b[f] is not None]; return max(v) if v else None
    P['Heap max MB'] = round(mx('heapMaxBytes') / 2**20) if mx('heapMaxBytes') else None
    P['Heap used peak MB'] = round(mx('heapUsedBytes') / 2**20) if mx('heapUsedBytes') else None
    cpu = [(b['cpuUserPct'] or 0) + (b['cpuSysPct'] or 0) for b in bs if b['cpuUserPct'] is not None]
    P['CPU user+sys peak %'] = round(max(cpu), 1) if cpu else 'null (not Linux)'
    P['RAM used peak/total GB'] = f"{mx('ramUsedBytes')/2**30:.1f}/{mx('ramTotalBytes')/2**30:.1f}" if mx('ramTotalBytes') else 'null (not Linux)'
    return P
cols = [pp(d) for d in pp_dirs]
print('| Figure | GE | ' + ' | '.join(os.path.basename(d.rstrip('/')) for d in pp_dirs) + ' |')
print('|---|---|' + '---|' * len(pp_dirs))
for k, v in G.items():
    print(f'| {k} | {v} | ' + ' | '.join(str(c.get(k)) for c in cols) + ' |')
