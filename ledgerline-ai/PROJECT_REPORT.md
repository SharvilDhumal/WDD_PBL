# Ledgerline AI — Project Report

## 1. Project overview

Ledgerline AI is a full-stack personal-finance dashboard. The browser application records income, expenses, budgets, recurring items, savings goals, and Safe-to-Spend settings. It calculates summaries and charts locally, stores the user's records in browser storage, and can send a summarized financial context to a Gemini-powered assistant through the Node.js server.

The project uses a single-page dashboard built with plain HTML, CSS, and JavaScript. Express serves the frontend and provides the AI chat API. There is no database server or frontend framework in the inspected application.

## 2. Project structure and entry points

| File | Role |
|---|---|
| `index.html` | Dashboard structure, forms, navigation, chart canvases, dialogs, and AI assistant panel. Loads `app.js`. |
| `app.js` | Main browser application: state, validation, local persistence, finance calculations, rendering, event handling, import/export, and AI chat client. |
| `styles.css` | Dark responsive interface, design tokens, dashboard layouts, component states, and accessibility-related styles. |
| `server.js` | Express server, static file hosting, `/api/chat` endpoint, Gemini integration, request checks, and rate limiting. |
| `package.json` | Node.js project metadata, scripts, runtime requirement, and direct dependencies. |
| `package-lock.json` | Resolved npm dependency versions. |
| `../voice-notify-v3.js` | Separate voice-entry and browser-notification script in the repository root; it is **not** loaded by `ledgerline-ai/index.html`. |

### Runtime flow

1. `npm start` runs `server.js` on `PORT`, or port `3001` when `PORT` is not set.
2. Express serves `index.html`, `styles.css`, and `app.js` from the `ledgerline-ai` directory.
3. The frontend initializes on `DOMContentLoaded`, loads validated data from `localStorage`, binds UI events, and renders dashboard sections.
4. When a user sends a question to Ledgerline AI, `app.js` constructs a financial summary and posts it to `/api/chat`.
5. The server forwards the request to the configured Gemini model and returns `{ "reply": "..." }`.

## 3. Technology stack

### Languages and runtime

- **HTML5** — semantic dashboard structure and forms.
- **CSS3** — responsive styling, CSS custom properties, animations, and reduced-motion behavior.
- **JavaScript** — browser-side application logic using standard browser APIs.
- **Node.js** — server runtime; `package.json` specifies Node.js `>=20`.
- **CommonJS** — server module format (`require`).

### Frameworks and direct dependencies

| Technology | Declared range | Resolved in lockfile | Purpose |
|---|---:|---:|---|
| Express | `^4.19.2` | `4.22.3` | HTTP server, static file hosting, and API route. |
| `@google/genai` | `^2.30.0` | `2.30.0` | Gemini generative-AI client used by `/api/chat`. |
| `dotenv` | `^16.4.5` | `16.6.1` | Loads local environment variables from `.env`. |
| `express-rate-limit` | `^7.4.0` | `7.5.1` | Limits calls to the chat endpoint. |

The browser code does not use React, Vue, Angular, or a charting package. The doughnut and trend charts are drawn directly with the Canvas 2D API. Google Fonts supplies **Inter** and **JetBrains Mono** when available; system fonts are specified as fallbacks.

### Browser APIs used

- `localStorage` for finance records, settings, and draft form state.
- Canvas 2D, `requestAnimationFrame`, and `devicePixelRatio` for charts and number animations.
- `fetch` for the AI chat request.
- `Blob`, `FileReader`, and object URLs for CSV/JSON export and JSON restore.
- `IntersectionObserver` for active sidebar navigation when supported.
- Standard DOM form, keyboard, pointer, and resize events.

The separate root-level voice script uses the Web Speech API and Notifications API. Those features are not part of the active `ledgerline-ai` page unless that script is separately included and its matching UI is provided.

## 4. Main functional areas

1. **Dashboard overview** — selected-month income, expenses, net balance, savings rate, and monthly budget status.
2. **Safe to Spend** — estimated daily allowance after expected income, upcoming recurring expenses, and a savings goal.
3. **Transaction management** — create, edit, delete, undo deletion, search, filter, and sort income and expense records.
4. **Budget tracking** — monthly budget and per-category spending targets, with warning/critical/over-budget states.
5. **Analytics** — expense-by-category doughnut chart, year-based monthly trend chart, and computed insight cards.
6. **Recurring items** — weekly, monthly, and yearly income/expense reminders; these are reminders and do not charge or record transactions automatically.
7. **Financial goals** — create, edit, and delete savings goals with saved/target progress and optional target dates.
8. **Data portability** — selected-month CSV export and full JSON backup/restore.
9. **Ledgerline AI** — conversational financial analysis based on context generated from the app's recorded data.
10. **Accessibility and interaction support** — semantic labels, keyboard operation, visible focus styling, reduced-motion support, live regions, modal focus handling, and keyboard shortcuts.

## 5. Data and persistence

The main application keeps its in-memory data in `state` in `app.js` and persists it in browser `localStorage` under `ledgerline-v3`. The persisted object includes:

- `version` and `lastIdSeq`
- `tx`: transactions with `id`, `type`, `desc`, `amount`, `cat`, and `date`
- `budget`: overall monthly spending limit
- `catBudgets`: optional per-expense-category targets
- `recurring`: recurring item descriptions, amounts, categories, frequency, and next occurrence
- `goals`: goal name, saved amount, target amount, and optional target date
- `sts`: next income date/amount and a savings goal used in Safe-to-Spend calculations

The app validates records when loading and importing, normalizes descriptions and monetary values, checks dates, and rejects invalid or duplicate IDs. Transaction amounts are represented as numbers and rounded to two decimal places for stored calculations.

**Persistence limitation:** this is browser-local storage, not a shared account or server database. Data is local to the browser profile and should be backed up using the JSON export if the user needs a portable copy.

## 6. Important functions

Line numbers refer to the current source files.

### Main browser application — `app.js`

| Function(s) | Approx. line(s) | Responsibility |
|---|---:|---|
| `$`, `esc`, `iso`, `parseDateOnly`, `round2` | 34–56 | DOM lookup, HTML escaping, date formatting/validation, and currency-safe rounding helpers. |
| `isValidTxRecord`, `isValidRecurring`, `isValidGoal` | 101–140 | Validate persisted/imported transaction, recurring-item, and goal records. |
| `normalizeTx`, `normalizeRec`, `normalizeGoal` | 141–156 | Clean and normalize records before they are stored. |
| `storageAvailable`, `load`, `save`, `nextId` | 157–261 | Check browser storage support, load and validate saved state, serialize state, and allocate IDs. |
| `txsForMonth`, `sumByType`, `monthIncome`, `monthExpenses`, `availableBalance`, `categoryTotals` | 314–340 | Select monthly records and calculate income, expenses, balance, and expense totals by category. |
| `budgetStatus` | 341–352 | Determine budget percentage and status (`unset`, `ok`, `warn`, `critical`, or `over`). |
| `computeSafeToSpend`, `nextOccurrence`, `renderSTS` | 369–482 | Calculate and display per-day Safe-to-Spend, including recurring expenses until the next income date or month end. |
| `renderStats` | 490–582 | Update monthly totals, savings rate, previous-month expense comparison, and overall budget progress. |
| `drawChart`, `paint`, `segAt`, `renderLegend`, `setFilter` | 590–717 | Draw the expense category doughnut chart, manage hover details, and apply category filters. |
| `incomeByMonthForYear`, `expensesByMonthForYear`, `renderTrend`, `computeTrendStats` | 718–851 | Aggregate data by month and render yearly income/expense analytics and trend statistics. |
| `renderCategoryBudgets` | 883–919 | Render category-level targets, spend, remaining amounts, and warning states. |
| `renderGoals`, `startEditGoal`, `saveGoal`, `resetGoalForm` | 925–1017 | Display and manage savings goals. |
| `renderTable` | 1021–1080 | Apply month, category, type, text, and amount filters; sort records; render transaction rows and summary. |
| `renderCatChips`, `updatePreview`, `validateForm`, `fillForm`, `resetForm` | 1086–1175 | Maintain transaction form categories, live balance preview, validation, edit setup, and reset behavior. |
| `saveDraft`, `loadDraft`, `clearDraft` | 1176–1200 | Save and restore an unfinished transaction form using browser storage. |
| `attemptSave`, `checkBudgetThen`, `finalizeSave` | 1204–1296 | Warn about negative balances and budget overages, then create or update a transaction with rollback on storage failure. |
| `showModal` | 1301–1345 | Display confirmation dialogs with Escape/backdrop handling and keyboard focus management. |
| `csvCell`, `exportCSV` | 1350–1376 | Format and download CSV for the selected month; prefixes spreadsheet-formula-like values to reduce formula execution risk. |
| `exportJSON`, `importJSONFile` | 1380–1514 | Create a full backup and validate/confirm/restore a backup file. |
| `renderInsights` | 1519–1591 | Produce local insight cards for budget state, month-over-month spending, savings, Safe-to-Spend, and upcoming payments. |
| `renderRecurring`, `syncRecurringCatOptions`, `startEditRecurring`, `saveRecurring`, `resetRecurringForm` | 1596–1691 | Display, validate, create, and edit recurring reminders. |
| `syncSTSInputs`, `saveSTSSettings` | 1697–1721 | Populate and validate Safe-to-Spend settings. |
| `refreshAll` | 1728–1738 | Refresh all dashboard summaries, charts, budgets, recurring cards, goals, and transaction rows. |
| `applyTheme`, `initMonthAndYearOptions` | 1743–1763 | Apply the dark theme and populate analytics year choices. |
| `bindEvents` | 1766–2090 | Connect form, filters, budgets, charts, import/export, goals, recurring items, shortcuts, and UI controls to their handlers. |
| `handleDelete` | 2094–2118 | Delete a transaction with animation, persistence handling, and an Undo action. |
| `buildContext` | 2159–2255 | Construct the selected-month financial context sent to the AI, including summaries and up to 60 recent monthly transactions. |
| `renderAIText`, `appendUserMessage`, `appendBotMessage`, `appendErrorMessage` | 2259–2320 | Safely display user and assistant messages and retryable errors. |
| `sendAIMessage` | 2360–2420 | Send the message, context, and bounded chat history to `/api/chat`; manage loading, response, and error states. |
| `openAI`, `closeAI`, `newChat`, `initAI` | 2432–2492 | Manage the assistant panel and its chat controls. |
| `initRail` | 2497–2519 | Maintain active navigation state using clicks and `IntersectionObserver`. |
| `init` | 2524–2552 | Bootstrap the app: load state, initialize controls, bind events, and render the dashboard. |

### Backend — `server.js`

| Function/route | Approx. line(s) | Responsibility |
|---|---:|---|
| `fail(res, status, message)` | 56–58 | Return a consistent JSON error response. |
| `POST /api/chat` | 67–156 | Validate the message/context/history, apply rate limiting, call Gemini, and return the assistant reply or a mapped error. |
| API fallback | 159–160 | Return JSON 404 responses for unmatched `/api` routes. |
| SPA fallback | 163–165 | Serve `index.html` for non-API routes. |
| `app.listen` | 168 onward | Start the server and log the selected port/model and whether an API key is configured. |

The chat route accepts `message`, optional structured `context`, and optional `history`; it checks message type/length, bounds the supplied history/context, and restricts history roles to `user` and `model`. The limiter allows up to 20 requests per 60-second window per client. The configured model defaults to `gemini-2.5-flash`.

### Separate root script — `voice-notify-v3.js`

This file is adjacent to, but not included in, the `ledgerline-ai` page. Its primary functions are:

- `parseSpeech` — extract an amount, transaction type, simple category, description, and today/yesterday date from recognized speech.
- `budgetLevel` — identify no warning, a 75% warning, or a budget overrun.
- `runTests` — run 11 inline checks (7 speech-parsing examples and 4 budget-level checks) and print the results in the browser console.
- `fillForm`, `speak` — transfer parsed speech into the transaction form and optionally speak a confirmation.
- `notify`, `updateNotifyButton`, `checkBudget` — request/display browser notifications and avoid repeating the same monthly budget alert.

The script looks for elements such as `mic`, `vlang`, and `notify`; those controls are not present in the inspected `ledgerline-ai/index.html`, which loads only `app.js`. Treat the voice/notification functionality as a separate prototype or integration component, not as an active feature of the current page.

## 7. AI assistant and configuration

The backend reads:

- `PORT` — optional server port; defaults to `3001`.
- `GEMINI_API_KEY` — required key for the Gemini API.
- `GEMINI_MODEL` — optional model name; defaults to `gemini-2.5-flash`.

The server loads `.env` with `dotenv`. Keep the API key in an untracked local environment file and do not place it in browser JavaScript. The system instruction describes the assistant as read-only and directs it to use the supplied financial context rather than inventing financial facts.

The browser sends data to the same-origin `POST /api/chat` endpoint. This includes calculated totals, recurring items, goals, previous-month data, trailing three-month summaries, and up to 60 transactions from the selected month. Consequently, using the AI feature sends that selected data context to the configured Gemini service.

## 8. Running the project

From the `ledgerline-ai` directory:

```powershell
npm install
npm start
```

Set `GEMINI_API_KEY` in a local `.env` file to enable chat. Open `http://localhost:3001` unless a different `PORT` is configured. For development, `npm run dev` starts Node's watch mode.

## 9. Scope notes

- No relational or document database, ORM, authentication system, or multi-user account service is declared in the inspected project.
- Finance records remain in the user's browser storage; the AI server uses only the context sent with each chat request.
- Recurring entries are forecast/reminder data. They do not automatically create transactions or trigger payments.
- Package scripts define `start` and `dev`; there is no npm `test`, build, or lint script in `package.json`.
- Voice recognition and notifications are in a separate root-level script and are not wired into the active dashboard HTML.
