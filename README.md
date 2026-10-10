# NeSL File Downloader — React + Vite + Node.js

This project turns the supplied Java/Selenium workflow into a React/Vite interface and a Node/Express/Selenium backend.

## Important deployment architecture

- **Netlify hosts only the React/Vite frontend.** Netlify's static hosting cannot launch Chrome on your company computer or run a long-lived Selenium browser session.
- **Run the Node backend on the computer that can access the NeSL portal** (for example, your company computer while connected to the required company network/VPN). The frontend calls that backend using `VITE_API_BASE_URL`.
- Do not put NeSL username/password in React code or Netlify frontend environment variables. Store them in `backend/.env` on the backend machine.
- Follow your company's authorization and IT/security policies before automating the portal or exposing a backend to the internet. Do not expose the backend publicly without authentication and HTTPS.

## Requirements

- Node.js 20+ recommended
- Google Chrome installed on the backend computer
- Access to `https://services.nesl.co.in/NeslPortalWebUtility/`

## 1. Install dependencies

From the project root:

```bash
npm run install:all
```

## 2. Configure backend

Copy `backend/.env.example` to `backend/.env`, then fill in credentials locally:

```env
PORT=8787
HOST=127.0.0.1
NESL_USERNAME=your_authorized_username
NESL_PASSWORD=your_password
CHROME_HEADLESS=false
DOWNLOAD_DIR=./downloads
OUTPUT_DIR=./output
STATUS_DIR=./status
```

`HOST=127.0.0.1` keeps the API local to the machine by default. If you later connect a Netlify-hosted UI, you will need a properly secured, reachable backend URL and CORS configuration; do not simply expose this local server publicly.

## 3. Start the backend

```bash
npm run dev --prefix backend
```

The backend health endpoint is `http://127.0.0.1:8787/api/health`.

## 4. Start the frontend locally

In another terminal:

```bash
npm run dev --prefix frontend
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`). The local frontend defaults to the local API.

## 5. Deploy the UI to Netlify

Push this project to a Git repository and import it in Netlify. Netlify build settings are in `netlify.toml` (base: `frontend`, build: `npm run build`, publish: `dist`). Configure `VITE_API_BASE_URL` only if you have a separately hosted, secured backend. **A Netlify deployment by itself will display the UI but will not download files from NeSL** until a reachable backend is configured.

## What it does

- Upload CSV/TXT or paste transaction IDs.
- Removes duplicate IDs while preserving order.
- Choose one of the three document modes:
  - **e-Stamped document**: E-Stamp must be `SUCCESS`; E-Sign may still be pending.
  - **Only e-Stamped document**: E-Stamp must be `SUCCESS`; E-Sign is not required.
  - **Fully executed document**: both E-Stamp and E-Sign must be `SUCCESS`.
- Waits for a new PDF, checks that its size is stable, and retries a failed download up to three attempts with a three-second pause.
- Renames downloaded PDFs to `<submitted transaction ID>.pdf` and creates CSV status reports.

The first two modes intentionally share the E-Stamp SUCCESS rule, matching the supplied Java program's download condition; they are kept as separate choices because you requested separate options.

## Notes

Portal DOM selectors and the `downloadfile(id)` JavaScript function are copied from the supplied automation. The portal may change; test with a small authorized list first. The backend processes one job at a time. Browser/portal authentication issues are reported in job logs.


## Download format preference

Before starting a job, choose one output preference in the UI:

- **Individual PDF files**: best for a small batch (around 1–5 IDs). After processing, each successful PDF has its own download button and is named using the submitted transaction ID. A Results CSV is also available.
- **One ZIP file**: best for larger batches. The ZIP includes successful PDFs and the generated status CSV reports.

The username and password entered in the UI are sent to the configured backend only when starting the job. The frontend does not save them to browser storage. Keep the backend on a trusted computer, use only authorized portal access, and do not expose the backend publicly without authentication and HTTPS.


## Troubleshooting: credentials and download state

- The top status now reports whether the local backend is reachable. It does not require credentials in `.env`, because the login credentials are entered in the page for each job.
- Enter the NeSL username and password in the **NeSL login** section. The Start download button stays disabled until IDs, credentials, and the backend connection are ready.
- While Selenium is working, the ready badge and job status show `Downloading…` / `running`; the progress and activity log update by polling the backend. Keep both terminals open.
- Start from the project root with `npm run install:all`, then `npm run dev`. The frontend runs at `http://localhost:5173` and the local backend at `http://127.0.0.1:8787`.
- If the job fails, check the backend terminal and the Activity log in the UI. This project requires Chrome installed and an authorized NeSL account with access to the portal.
