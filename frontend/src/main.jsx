import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle, ArrowDownToLine, CheckCircle2, Copy, Eye, EyeOff, FileCheck2,
  LoaderCircle, Play, RefreshCw, Trash2, Upload, X,
} from 'lucide-react';
import './styles.css';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

const MODES = [
  { id: 'estamped', title: 'e-Stamped', desc: 'E-Stamp done, E-Sign may be pending' },
  { id: 'only-estamped', title: 'Only e-Stamped', desc: 'E-Stamp done, E-Sign not done' },
  { id: 'fully-executed', title: 'Fully executed', desc: 'E-Stamp and E-Sign both done' },
];
const FORMATS = [
  { id: 'pdf', title: 'Individual PDFs', hint: 'Best for 1–5 IDs' },
  { id: 'zip', title: 'One ZIP', hint: 'PDFs and reports together' },
];
const ID_LIST_LIMIT = 300;

function uniqueIds(raw) {
  const seen = new Set();
  const out = [];
  for (const token of raw.split(/[\r\n,;\t ]+/).map(x => x.trim()).filter(Boolean)) {
    const key = token.toLocaleUpperCase();
    if (!seen.has(key)) { seen.add(key); out.push(token); }
  }
  return out;
}

function parseFile(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.split(',')[0].replace(/^\s*["']|["']\s*$/g, '').trim())
    .filter((v, i) => v && !(i === 0 && /transaction|nesl|submitter/i.test(v)));
}

function App() {
  const [ids, setIds] = useState([]);
  const [paste, setPaste] = useState('');
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState('fully-executed');
  const [retryEnabled, setRetryEnabled] = useState(true);
  const [outputFormat, setOutputFormat] = useState('pdf');
  const [portalUsername, setPortalUsername] = useState('');
  const [portalPassword, setPortalPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [health, setHealth] = useState('checking');
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState('results');
  const fileRef = useRef(null);
  const pollRef = useRef(null);

  const pasted = useMemo(() => uniqueIds(paste), [paste]);
  const currentIds = useMemo(() => uniqueIds([...ids, ...pasted].join('\n')), [ids, pasted]);
  const duplicatesRemoved = Math.max(0, ids.length + pasted.length - currentIds.length);

  useEffect(() => { checkHealth(); return () => clearInterval(pollRef.current); }, []);

  async function checkHealth() {
    setHealth('checking');
    try {
      const r = await fetch(`${API_BASE}/api/health`);
      const data = await r.json();
      setHealth(r.ok && data.ok ? 'connected' : 'offline');
    } catch { setHealth('offline'); }
  }

  async function onFile(file) {
    if (!file) return;
    setError('');
    if (!/\.(csv|txt)$/i.test(file.name)) { setError('Upload a .csv or .txt file.'); return; }
    try {
      const parsed = parseFile(await file.text());
      setIds(prev => uniqueIds([...prev, ...parsed].join('\n')));
      setFileName(file.name);
    } catch { setError('Could not read that file. Try another CSV or TXT file.'); }
  }

  function removeId(target) {
    const t = target.toUpperCase();
    setIds(prev => prev.filter(x => x.toUpperCase() !== t));
    setPaste(prev => uniqueIds(prev).filter(x => x.toUpperCase() !== t).join('\n'));
  }

  function clearAll() {
    setIds([]); setPaste(''); setFileName(''); setError('');
  }

  function downloadCleanCsv() {
    const csv = ['NESL Transaction ID', ...currentIds].map(x => `"${x.replaceAll('"', '""')}"`).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'NESL_Transaction_ID.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  async function copyIds() {
    try { await navigator.clipboard.writeText(currentIds.join(', ')); }
    catch { setError('The browser blocked clipboard access.'); }
  }

  async function startJob() {
    setError(''); setSubmitting(true); setJob(null); setTab('results');
    try {
      const response = await fetch(`${API_BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionIds: currentIds, mode, retryEnabled, outputFormat,
          username: portalUsername.trim(), password: portalPassword,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start the download job.');
      setJob({ id: data.jobId, status: data.status, logs: [], results: [], total: currentIds.length, completed: 0, success: 0, skipped: 0, failed: 0 });
      pollJob(data.jobId);
    } catch (e) { setError(e.message || 'Backend is not reachable.'); }
    finally { setSubmitting(false); }
  }

  function pollJob(id) {
    clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/jobs/${id}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Could not read job status.');
        setJob(data);
        if (['completed', 'failed'].includes(data.status)) clearInterval(pollRef.current);
      } catch (e) { setError(e.message); clearInterval(pollRef.current); }
    };
    poll();
    pollRef.current = setInterval(poll, 1800);
  }

  const busy = submitting || job?.status === 'running' || job?.status === 'queued';
  const credentialsReady = Boolean(portalUsername.trim() && portalPassword);
  const canStart = currentIds.length > 0 && credentialsReady && health !== 'offline' && !busy;
  const hint = busy ? 'Working…'
    : health === 'offline' ? 'Start the backend to continue'
    : !currentIds.length ? 'Add transaction IDs to begin'
    : !credentialsReady ? 'Enter your NeSL login to continue'
    : `${currentIds.length} ${currentIds.length === 1 ? 'document' : 'documents'} ready`;
  const healthLabel = { connected: 'Backend connected', checking: 'Checking…', offline: 'Backend offline' }[health];
  const showJob = Boolean(job);

  return (
    <div className="shell">
      <header className="bar">
        <div className="brand"><span className="mark"><FileCheck2 size={16} /></span>NeSL File Downloader</div>
        <button className={`status ${health}`} onClick={checkHealth} title="Check backend connection">
          <i />{healthLabel}<RefreshCw size={13} />
        </button>
      </header>

      {error && (
        <div className="alert" role="alert">
          <AlertCircle size={16} /><span>{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss"><X size={15} /></button>
        </div>
      )}

      {!showJob ? (
        <main className="stage">
          {/* ---------- Transaction IDs ---------- */}
          <section
            className={`card ids ${dragging ? 'drag' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files?.[0]); }}
          >
            <div className="card-head">
              <div>
                <h2>Transaction IDs</h2>
                <p>
                  {currentIds.length
                    ? <><b>{currentIds.length}</b> unique{duplicatesRemoved > 0 && <> · {duplicatesRemoved} duplicate{duplicatesRemoved > 1 ? 's' : ''} removed</>}</>
                    : 'Paste IDs or drop a CSV / TXT file anywhere on this panel'}
                </p>
              </div>
              <div className="head-actions">
                <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
                <button className="btn ghost sm" onClick={() => fileRef.current?.click()}><Upload size={14} />Upload</button>
                <button className="icon-btn" disabled={!currentIds.length} onClick={copyIds} title="Copy IDs"><Copy size={15} /></button>
                <button className="icon-btn" disabled={!currentIds.length} onClick={downloadCleanCsv} title="Export CSV"><ArrowDownToLine size={15} /></button>
                <button className="icon-btn" disabled={!currentIds.length && !paste} onClick={clearAll} title="Clear all"><Trash2 size={15} /></button>
              </div>
            </div>

            {fileName && (
              <div className="file-pill">
                <span>{fileName}</span><em>{ids.length} loaded</em>
                <button onClick={() => { setFileName(''); setIds([]); }} aria-label="Remove file"><X size={13} /></button>
              </div>
            )}

            <textarea
              value={paste}
              onChange={e => setPaste(e.target.value)}
              placeholder={'DDE_807911\nDDE_807998\nDDE_808011'}
              spellCheck={false}
              aria-label="Transaction IDs"
            />

            <div className="chips" aria-label="Unique IDs">
              {currentIds.length === 0 && <span className="empty">Unique IDs appear here.</span>}
              {currentIds.slice(0, ID_LIST_LIMIT).map(id => (
                <span className="chip" key={id}>{id}<button onClick={() => removeId(id)} aria-label={`Remove ${id}`}><X size={11} /></button></span>
              ))}
              {currentIds.length > ID_LIST_LIMIT && <span className="empty">+ {currentIds.length - ID_LIST_LIMIT} more will be processed</span>}
            </div>
          </section>

          {/* ---------- Options ---------- */}
          <aside className="card opts">
            <div className="opts-scroll">
              <div className="field">
                <label className="label">Document status</label>
                <div className="radio-list" role="radiogroup">
                  {MODES.map(m => (
                    <button key={m.id} role="radio" aria-checked={mode === m.id} className={`radio-row ${mode === m.id ? 'on' : ''}`} onClick={() => setMode(m.id)}>
                      <span className="dot" />
                      <span><strong>{m.title}</strong><small>{m.desc}</small></span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="label">Output</label>
                <div className="segment" role="radiogroup">
                  {FORMATS.map(f => (
                    <button key={f.id} role="radio" aria-checked={outputFormat === f.id} className={outputFormat === f.id ? 'on' : ''} onClick={() => setOutputFormat(f.id)} title={f.hint}>{f.title}</button>
                  ))}
                </div>
              </div>

              <div className="row">
                <div><strong>Retry failed downloads</strong><small>{retryEnabled ? 'Up to 3 attempts, 3 s apart' : 'Single attempt'}</small></div>
                <button className={`toggle ${retryEnabled ? 'on' : ''}`} role="switch" aria-checked={retryEnabled} onClick={() => setRetryEnabled(v => !v)}><span /></button>
              </div>

              <div className="field">
                <label className="label" htmlFor="u">NeSL login</label>
                <input id="u" className="input" autoComplete="username" value={portalUsername} onChange={e => setPortalUsername(e.target.value)} placeholder="Username" />
                <div className="pw">
                  <input className="input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={portalPassword} onChange={e => setPortalPassword(e.target.value)} placeholder="Password" aria-label="Password" />
                  <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                </div>
                <p className="hint">Used for this job only. Never stored.</p>
              </div>
            </div>

            <div className="start">
              <button className="btn primary" disabled={!canStart} onClick={startJob}>
                {busy ? <><LoaderCircle className="spin" size={16} />Processing…</> : <><Play size={14} fill="currentColor" />Start download</>}
              </button>
              <p className={canStart ? 'ok' : ''}>{hint}</p>
            </div>
          </aside>
        </main>
      ) : (
        <JobView job={job} outputFormat={outputFormat} tab={tab} setTab={setTab} onBack={() => setJob(null)} />
      )}
    </div>
  );
}

function JobView({ job, outputFormat, tab, setTab, onBack }) {
  const done = ['completed', 'failed'].includes(job.status);
  const total = job.total || 0;
  const progress = total ? Math.round(((job.completed || 0) / total) * 100) : 0;
  const files = (job.results || []).filter(r => r.status === 'SUCCESS' && r.file);
  const title = job.status === 'completed' ? 'Complete' : job.status === 'failed' ? 'Stopped' : 'Downloading';

  return (
    <main className="stage job">
      <section className="card run">
        <div className="card-head">
          <div>
            <h2>{title}{!done && <LoaderCircle className="spin inline" size={15} />}</h2>
            <p>Job {job.id}</p>
          </div>
          <button className="btn ghost sm" disabled={!done} onClick={onBack}>New download</button>
        </div>

        <div className="progress">
          <div className="track"><span style={{ width: `${progress}%` }} /></div>
          <div className="numbers">
            <b>{job.completed || 0} / {total}</b>
            <span className="s ok"><CheckCircle2 size={14} />{job.success || 0} downloaded</span>
            <span className="s warn">{job.skipped || 0} skipped</span>
            <span className="s bad">{job.failed || 0} failed</span>
          </div>
        </div>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'on' : ''} onClick={() => setTab('results')}>Results</button>
          <button role="tab" aria-selected={tab === 'log'} className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Activity{job.logs?.length ? ` (${job.logs.length})` : ''}</button>
        </div>

        <div className="pane">
          {tab === 'results' ? (
            job.results?.length ? (
              <table>
                <thead><tr><th>Transaction ID</th><th>E-Stamp</th><th>E-Sign</th><th>Result</th><th>Message</th></tr></thead>
                <tbody>
                  {job.results.map((r, i) => (
                    <tr key={`${r.transactionId}-${i}`}>
                      <td><code>{r.transactionId}</code></td>
                      <td>{r.eStampStatus || '—'}</td>
                      <td>{r.eSignStatus || '—'}</td>
                      <td><span className={`badge ${r.status.toLowerCase()}`}>{r.status}</span></td>
                      <td className="msg">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="empty pad">Results appear as each document is processed.</p>
          ) : (
            <div className="log">
              {(job.logs || []).slice(-60).map((l, i) => (
                <div key={i}><time>{new Date(l.at).toLocaleTimeString()}</time><span className={`lvl ${l.level}`}>{l.level}</span><span>{l.message}</span></div>
              ))}
              {!job.logs?.length && <p className="empty pad">No activity yet.</p>}
            </div>
          )}
        </div>
      </section>

      <aside className="card files">
        <div className="card-head"><div><h2>Files</h2><p>{done ? (outputFormat === 'zip' ? 'Everything in one archive' : `${files.length} PDF${files.length === 1 ? '' : 's'} ready`) : 'Available when the job finishes'}</p></div></div>
        <div className="file-list">
          {done && outputFormat === 'zip' && (
            <a className="btn primary" href={`${API_BASE}/api/jobs/${job.id}/downloads.zip`}><ArrowDownToLine size={15} />Download ZIP</a>
          )}
          {done && outputFormat !== 'zip' && (
            <>
              <a className="btn ghost" href={`${API_BASE}/api/jobs/${job.id}/results.csv`}><ArrowDownToLine size={15} />Results CSV</a>
              {files.map(r => (
                <a key={r.transactionId} className="file-row" href={`${API_BASE}/api/jobs/${job.id}/files/${encodeURIComponent(r.transactionId)}.pdf`}>
                  <code>{r.transactionId}.pdf</code><ArrowDownToLine size={14} />
                </a>
              ))}
            </>
          )}
          {!done && <p className="empty pad">Keep the backend running while documents download.</p>}
        </div>
      </aside>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
