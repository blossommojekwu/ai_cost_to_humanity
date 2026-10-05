import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Serve ai-cost.html as the front end at "/" instead of index.html.
const serveAiCost = () => ({
  name: 'serve-ai-cost',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url === '/index.html') req.url = '/ai-cost.html'
      next()
    })
  },
})

export default defineConfig({
  plugins: [react(), serveAiCost()],
  build: {
    rollupOptions: { input: resolve(__dirname, 'ai-cost.html') },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:5000'
    }
  }
})
