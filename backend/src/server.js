import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runDownloadJob } from './worker.js';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const origin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: origin.split(',').map(s => s.trim()), methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '2mb' }));

const jobs = new Map();
let running = false;

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'NeSL File Downloader backend', seleniumConfigured: Boolean(process.env.NESL_USERNAME && process.env.NESL_PASSWORD) }));

app.post('/api/jobs', async (req, res) => {
  const ids = Array.isArray(req.body?.transactionIds) ? req.body.transactionIds : [];
  const mode = req.body?.mode;
  const username = String(req.body?.username || process.env.NESL_USERNAME || '').trim();
  const password = String(req.body?.password || process.env.NESL_PASSWORD || '');
  const retryEnabled = req.body?.retryEnabled !== false;
  const validModes = new Set(['estamped', 'only-estamped', 'fully-executed']);
  const cleaned = [...new Set(ids.map(v => String(v ?? '').trim()).filter(Boolean))];
  if (!cleaned.length) return res.status(400).json({ error: 'Add at least one transaction ID.' });
  if (cleaned.length > 500) return res.status(400).json({ error: 'A job can contain at most 500 transaction IDs.' });
  if (!validModes.has(mode)) return res.status(400).json({ error: 'Select a valid document mode.' });
  if (!username || !password) return res.status(400).json({ error: 'Enter your NeSL username and password before starting the download.' });
  if (running) return res.status(409).json({ error: 'Another download job is already running. Wait for it to finish.' });

  const job = { id: randomUUID(), status: 'queued', mode, retryEnabled, total: cleaned.length, completed: 0, success: 0, skipped: 0, failed: 0, logs: [], results: [], createdAt: new Date().toISOString() };
  jobs.set(job.id, job);
  res.status(202).json({ jobId: job.id, status: job.status });
  running = true;
  setImmediate(async () => {
    try {
      job.status = 'running';
      await runDownloadJob({ ids: cleaned, mode, retryEnabled, username, password, job, onProgress: update => Object.assign(job, update) });
      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.logs.push({ at: new Date().toISOString(), level: 'error', message: err?.message || 'Unexpected job failure.' });
    } finally {
      job.finishedAt = new Date().toISOString();
      running = false;
    }
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found. Jobs are kept in memory until this backend restarts.' });
  res.json(job);
});

app.get('/api/jobs/:id/results.csv', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = [['NESL Transaction ID', 'Status', 'File', 'E-Stamp Status', 'E-Sign Status', 'Message'], ...job.results.map(r => [r.transactionId, r.status, r.file, r.eStampStatus, r.eSignStatus, r.message])];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nesl-results-${job.id.slice(0, 8)}.csv"`);
  res.send('\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n'));
});

app.get('/api/jobs/:id/files/:transactionId.pdf', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!['completed', 'failed'].includes(job.status)) return res.status(409).json({ error: 'Wait until the job finishes before downloading PDFs.' });
  const requestedId = req.params.transactionId;
  const result = (job.results || []).find(r => r.status === 'SUCCESS' && r.transactionId === requestedId && r.file);
  if (!result) return res.status(404).json({ error: 'No successfully downloaded PDF exists for this transaction ID.' });
  const filePath = path.join(job.outputDirectory || '', result.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'The PDF file is no longer available on the backend.' });
  res.download(filePath, `${result.transactionId}.pdf`);
});

app.get('/api/jobs/:id/downloads.zip', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!['completed', 'failed'].includes(job.status)) return res.status(409).json({ error: 'Wait until the job finishes before exporting files.' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="nesl-file-downloader-${job.id.slice(0, 8)}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); else res.destroy(err); });
  archive.pipe(res);
  for (const result of job.results || []) {
    if (result.status !== 'SUCCESS' || !result.file) continue;
    const filePath = path.join(job.outputDirectory || '', result.file);
    if (fs.existsSync(filePath)) archive.file(filePath, { name: `PDFs/${result.file}` });
  }
  for (const [kind, filePath] of Object.entries(job.statusFiles || {})) {
    if (filePath && fs.existsSync(filePath)) archive.file(filePath, { name: `Status/${path.basename(filePath)}` });
  }
  archive.finalize();
});

app.listen(port, host, () => console.log(`NeSL File Downloader API listening at http://${host}:${port}`));
