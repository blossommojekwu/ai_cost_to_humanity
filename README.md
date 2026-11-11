# AI Cost to Humanity - Incident Search

A full-stack application for searching AI incidents using Gemini embeddings. Features a chat-like interface that connects to your personal AI incidents dataset (1,600+ entries) and finds relevant correlations.

## Project Structure

```
ai_cost_to_humanity/
├── server.ts                 # Express backend with Gemini API integration (TypeScript)
├── tsconfig.json             # Backend TypeScript configuration
├── package.json              # Root dependencies
├── .env                      # Environment variables (create this file)
├── types/
│   └── index.ts              # Shared TypeScript type definitions
├── data/
│   └── ai_incidents.json     # Your 1,600+ AI incidents dataset (place here)
└── client/                   # React frontend (TypeScript)
    ├── package.json
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── vite.config.js
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── types.ts
        ├── index.css
        └── components/
            ├── ChatMessage.tsx
            └── SearchInput.tsx
```

## Setup Instructions

### 1. Prerequisites

- Node.js 18+ installed
- Gemini API key (get one from [Google AI Studio](https://makersuite.google.com/app/apikey))

### 2. Install Dependencies

```bash
npm install
cd client && npm install && cd ..
```

### 3. Environment Setup

Create a `.env` file in the root directory:

```env
GEMINI_API_KEY=your_gemini_api_key_here
PORT=5000
```

### 4. Add Your Dataset

Create a `data` folder in the root directory and add your AI incidents dataset:

```bash
mkdir -p data
# Place your ai_incidents.json file here
```

**Dataset Format** - The JSON should be an array of incident objects:

```json
[
  {
    "id": 1,
    "title": "Incident Title",
    "description": "Brief description",
    "content": "Detailed incident information",
    "date": "2024-01-01"
  },
  ...
]
```

The backend will search `title`, `description`, and `content` fields for embeddings.

### 5. Run the Application

#### Development Mode (both frontend and backend):
```bash
npm run dev
```

This starts:
- Frontend: http://localhost:3000
- Backend: http://localhost:5000

#### Run backend only (with auto-reload):
```bash
npm run server:dev
```

#### Run frontend only:
```bash
cd client && npm run dev
```

#### Build for Production:
```bash
npm run build
```

This compiles TypeScript and builds the React app. Output:
- Backend: `dist/server.js`
- Frontend: `client/dist/`

#### Deploy Frontend to Cloudflare Pages

With the repository root as the project root, set the build command to
`npm install && npm --prefix client install --include=dev && npm --prefix client run build:web`
and the build output directory to `client/dist`. Deploy the built directory,
not the `client` source directory.

The frontend also needs the Express backend: deploy it separately with
`GEMINI_API_KEY` configured and route `/api/*` on the site to that backend.
The Vite development proxy does not run on Cloudflare Pages. The backend needs
access to the dataset and writable persistent storage for its SQLite database.

#### Run Production Build:
```bash
npm run server
```

## How It Works

1. **User Input**: Type a query in the chat interface
2. **Embedding Generation**: The query is converted to a Gemini embedding
3. **Similarity Search**: Each incident in your dataset is embedded and compared
4. **Results**: Top 10 matching incidents are returned with relevance scores
5. **Display**: Results are shown in a chat message format with match percentages

## API Endpoints

### POST `/api/search`
- **Body**: `{ "query": "your search query" }`
- **Response**: 
```json
{
  "query": "search query",
  "results": [
    {
      "title": "Incident Title",
      "description": "...",
      "similarity": 0.85,
      "relevanceScore": 85
    }
  ],
  "totalMatches": 42
}
```

### GET `/api/health`
- **Response**: `{ "status": "ok", "datasetSize": 1600 }`

## Features

- ✅ Chat-like UI for intuitive search
- ✅ Real-time embedding generation with Gemini
- ✅ Cosine similarity matching for accurate correlation
- ✅ Support for 1,600+ incident dataset
- ✅ Relevance scoring (0-100%)
- ✅ Error handling and user feedback
- ✅ Responsive design with Tailwind CSS
- ✅ Loading states and animations

## Customization

### Change Result Count
Edit `server.js`, line ~75:
```javascript
const topResults = results.slice(0, 10); // Change 10 to desired count
```

### Customize UI
- Modify colors in `client/src/components/ChatMessage.jsx` (Tailwind classes)
- Edit chat bubble styling in the `isBot` ternary operator
- Change layout in `client/src/App.jsx`

### Search Fields
By default, the backend searches title, description, and content. To add more fields, edit `server.ts` line ~100:
```typescript
const incidentText = `${incident.title} ${incident.description} ${incident.content} ${incident.yourNewField}`.trim();
```

## Troubleshooting

**"Dataset not loaded"** - Ensure `data/ai_incidents.json` exists and is valid JSON

**CORS errors** - Backend proxy is configured in `vite.config.js`. Restart both servers if issues persist.

**API key errors** - Verify `GEMINI_API_KEY` is correctly set in `.env` and has embedding permissions

**Slow searches** - Gemini embedding API calls are rate-limited. For large-scale applications, consider batch processing.

## Future Enhancements

- Cache embeddings to avoid redundant API calls
- Add filtering by date, severity, category
- Implement pagination for large result sets
- Add result export (PDF, CSV)
- Dark mode toggle
- Advanced query syntax support
