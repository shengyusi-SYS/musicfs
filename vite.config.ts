import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web', plugins: [react()],
  optimizeDeps: { include: ['react', 'react-dom/client', 'antd', '@ant-design/icons', '@tanstack/react-query', '@rjsf/antd', '@rjsf/validator-ajv8', 'react-error-boundary'] },
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '^/api/': 'http://127.0.0.1:8787', '^/dav(?:/|$)': 'http://127.0.0.1:8787' }
  }
});
