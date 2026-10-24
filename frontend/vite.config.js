import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 3001}`, // API_PORT=3002 = dev backend beside the installed app
        changeOrigin: true,
        proxyTimeout: 120000,
        timeout: 120000,
      }
    }
  }
})
