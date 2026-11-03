import { defineConfig } from 'vite';

// In production builds, drop the dev-server websocket from the CSP so the
// app cannot open any network connection at all.
const lockDownCsp = {
  name: 'lock-down-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(' ws:', ''),
};

export default defineConfig({
  base: './',
  plugins: [lockDownCsp],
  // Pre-bundle the lazily loaded libraries so the dev server never reloads mid-session.
  optimizeDeps: {
    include: ['mammoth', 'docx', 'xlsx', 'jszip', 'pptxgenjs', 'pdf-lib', 'pdfjs-dist/legacy/build/pdf.mjs', 'jspdf', 'html2canvas', 'tesseract.js', 'wasm-feature-detect'],
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 3000,
  },
});
